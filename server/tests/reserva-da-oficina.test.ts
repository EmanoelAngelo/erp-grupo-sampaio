/**
 * A PEÇA RESERVA NA OS — rodada 55.
 *
 * ============================================================================
 * O QUE ESTAVA ERRADO
 * ============================================================================
 *
 * A peça baixava do estoque NO LANÇAMENTO. Só que o lançamento acontece antes
 * do cliente decidir: a própria oficina exige peça ou mão de obra lançada para
 * poder PEDIR a aprovação do orçamento ("Lance mão de obra ou peças antes de
 * pedir a aprovação"). Então a corrente era esta:
 *
 *   1. o mecânico monta o orçamento lançando as peças  -> gaveta esvazia
 *   2. o cliente olha o valor e diz NÃO
 *   3. a peça continua fora do estoque, para sempre
 *
 * A volta existia (devolver peça), mas dependia de alguém lembrar. Ninguém
 * lembra de desfazer um orçamento recusado.
 *
 * ============================================================================
 * A REGRA DESTA RODADA, EM UMA FRASE
 * ============================================================================
 *
 * A peça lançada na OS RESERVA. A reserva vira BAIXA quando o serviço é
 * autorizado a acontecer — na aprovação do cliente, ou na conclusão técnica —,
 * e volta sozinha para a gaveta quando o cliente recusa.
 *
 * É o que o sistema anterior PROMETIA num comentário e nunca fez: lá o
 * lançamento reservava, e nenhum caminho de pagamento consumia a reserva.
 * Cada OS paga corroía o disponível para sempre, porque `quantidadeReservada`
 * só subia. Aqui a reserva tem os dois lados, e os dois são medidos.
 *
 * ============================================================================
 * POR QUE A RESERVA E NÃO A BAIXA
 * ============================================================================
 *
 * Reserva não mente sobre a prateleira: `quantity` fica como está e o que
 * muda é `reserved` — a peça ESTÁ na gaveta, prometida a um conserto. Isso é
 * exatamente a verdade física entre orçar e consertar, e é o que impede a
 * mesma peça de ser vendida no balcão enquanto uma OS conta com ela.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { resetDbForTests } from '../src/db/database.js';
import { getConnection } from '../src/db/sqlite.js';
// O código e o link moram selados fora do corpo da fila (GAP-PRD-007): o
// teste lê o e-mail como o CLIENTE o recebe, pela montagem do carteiro.
import { textoDeEntrega } from '../src/services/notifications/EmailService.js';
import { confirmarEmail } from '../src/services/core/CustomerPortalService.js';
import { inventoryReconciliation } from '../src/services/core/InventoryReconciliation.js';
import { loginForTest } from './helpers/auth.js';

const app = createApp();
let gerente: { Authorization: string };
let mecanico: { Authorization: string };
let caixa: { Authorization: string };
let companyId: string;
let workshopId: string;
let n = 0;

const P = (token: string) => ({ 'x-portal-token': token });

beforeEach(async () => {
  resetDbForTests();
  n = 0;

  const g = await loginForTest(app, {
    userId: 'ger-55',
    companyId: 'oficina-55',
    profileCodes: ['gerente_oficina'],
  });
  gerente = { Authorization: `Bearer ${g.body.accessToken}` };
  companyId = g.body.company.id;

  const m = await loginForTest(app, {
    userId: 'mec-55',
    companyId: 'oficina-55',
    profileCodes: ['mecanico'],
  });
  mecanico = { Authorization: `Bearer ${m.body.accessToken}` };

  const c = await loginForTest(app, {
    userId: 'caixa-55',
    companyId: 'oficina-55',
    profileCodes: ['operador_caixa_oficina'],
  });
  caixa = { Authorization: `Bearer ${c.body.accessToken}` };

  workshopId = 'wk-55';
  getConnection()
    .prepare(
      `INSERT INTO core_workshops (id, company_id, slug, name, kind, active, created_at)
       VALUES (?, ?, 'mob-55', 'Bancada 55', 'mobility', 1, ?)`,
    )
    .run(workshopId, companyId, new Date().toISOString());
});

/** Peça da bancada com saldo em gaveta. */
async function peca(nome: string, qtd: number, precoCents = 9000): Promise<string> {
  const p = await request(app)
    .post('/api/v1/core/products')
    .set(gerente)
    .send({ name: nome, priceCents: precoCents, costCents: 3000 });

  getConnection()
    .prepare("UPDATE core_products SET kind = 'part', workshop_id = ?, min_stock = 1 WHERE id = ?")
    .run(workshopId, p.body.id);

  if (qtd > 0) {
    await request(app).post('/api/v1/core/stock/movements').set(gerente).send({
      productId: p.body.id,
      movementType: 'in',
      quantity: qtd,
      referenceType: 'entrada',
      referenceId: `carga-${p.body.id}`,
    });
  }
  return p.body.id as string;
}

function gaveta(productId: string): { quantity: number; reserved: number } {
  const row = getConnection()
    .prepare('SELECT quantity, reserved FROM core_stock WHERE company_id = ? AND product_id = ?')
    .get(companyId, productId) as { quantity: number; reserved: number } | undefined;
  return { quantity: row?.quantity ?? 0, reserved: row?.reserved ?? 0 };
}

function razao(productId: string): { movement_type: string; kind: string; quantity: number; reserved_delta: number }[] {
  return getConnection()
    .prepare(
      `SELECT movement_type, kind, quantity, reserved_delta
         FROM core_stock_movements
        WHERE company_id = ? AND product_id = ?
        ORDER BY created_at, rowid`,
    )
    .all(companyId, productId) as unknown as {
    movement_type: string;
    kind: string;
    quantity: number;
    reserved_delta: number;
  }[];
}

/** Cliente com portal aberto — é quem aprova e quem recusa o orçamento. */
async function clienteComPortal(): Promise<{ customerId: string; token: string }> {
  n += 1;
  const documento = `5554443332${n}`;
  const email = `dono55-${n}@exemplo.com`;
  const agora = new Date().toISOString();
  const customerId = `cli-55-${n}`;
  getConnection()
    .prepare(
      `INSERT INTO core_customers (id, company_id, name, document, email, active, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 1, ?, ?)`,
    )
    .run(customerId, companyId, `Dono ${n}`, documento, email, agora, agora);

  const r = await request(app)
    .post('/api/v1/loja/portal/registrar')
    .send({ termsAccepted: true, email, document: documento, password: 'Portal@2026' });
  expect(r.status).toBe(201);

  const linha = getConnection()
    .prepare(
      `SELECT id FROM core_email_queue
        WHERE template = 'verificacao_email' AND to_address = ?
        ORDER BY created_at DESC LIMIT 1`,
    )
    .get(email) as { id: string } | undefined;
  const codigo = (linha ? textoDeEntrega(linha.id) : null)?.match(/é: (\d{6})/)?.[1];
  expect(codigo, 'codigo de verificacao ausente na fila').toBeTruthy();
  confirmarEmail({ accountId: r.body.account.id as string, codigo });

  return { customerId, token: r.body.token as string };
}

/** OS assumida pelo mecânico — assumir é o que amarra a OS ao técnico. */
async function osAssumida(customerId?: string): Promise<string> {
  const os = await request(app)
    .post('/api/v1/core/workshop/orders')
    .set(gerente)
    .send({ customerName: 'Cliente', workshopId, complaint: 'não liga', customerId });
  expect(os.status).toBe(201);
  const assumida = await request(app)
    .post(`/api/v1/core/workshop/orders/${os.body.id}/assume`)
    .set(mecanico)
    .send({ status: 'em_andamento', comment: 'assumindo' });
  expect(assumida.status).toBeLessThan(300);
  return os.body.id as string;
}

async function lancar(orderId: string, productId: string, quantity: number) {
  return request(app)
    .post(`/api/v1/core/workshop/orders/${orderId}/parts`)
    .set(mecanico)
    .send({ productId, quantity });
}

/** A linha da peça na OS. A resposta do lançamento devolve a ORDEM, não a linha. */
function linhaDaPeca(orderId: string): string {
  const row = getConnection()
    .prepare('SELECT id FROM core_service_order_parts WHERE order_id = ? ORDER BY created_at LIMIT 1')
    .get(orderId) as { id: string };
  return row.id;
}

// ============================================================================

describe('lançar a peça reserva — a gaveta não mente', () => {
  it('a peça continua na prateleira, prometida ao conserto', async () => {
    const orderId = await osAssumida();
    const produto = await peca('Controlador 48V', 6);

    const res = await lancar(orderId, produto, 2);
    expect(res.status).toBe(201);

    // O FÍSICO NÃO ANDOU: a peça está na gaveta, e é verdade — o mecânico
    // ainda não montou nada, o cliente nem viu o orçamento.
    expect(gaveta(produto)).toEqual({ quantity: 6, reserved: 2 });

    // E o razão registra o evento sem mentir sobre o saldo.
    const linhas = razao(produto);
    const reserva = linhas.filter((l) => l.movement_type === 'reserve');
    expect(reserva).toHaveLength(1);
    expect(reserva[0].kind).toBe('WORKSHOP_PART_RESERVATION');
    expect(reserva[0].quantity).toBe(0);
    expect(reserva[0].reserved_delta).toBe(2);

    // Nenhuma saída ainda: o que saiu do disponível é promessa, não baixa.
    expect(linhas.some((l) => l.movement_type === 'out')).toBe(false);
  });

  it('o balcão não vende o que a OS prometeu: o disponível cai', async () => {
    const orderId = await osAssumida();
    const produto = await peca('Bateria 72V', 3);
    expect((await lancar(orderId, produto, 2)).status).toBe(201);

    const lista = await request(app).get('/api/v1/core/workshop/parts').set(gerente);
    const item = lista.body.items.find((i: { id: string }) => i.id === produto);
    expect(item.stock_quantity).toBe(3);
    expect(item.reserved).toBe(2);
    expect(item.available).toBe(1);
  });

  it('duas OS não prometem a mesma peça', async () => {
    const produto = await peca('Módulo raro', 1);
    const primeira = await osAssumida();
    expect((await lancar(primeira, produto, 1)).status).toBe(201);

    const segunda = await osAssumida();
    const res = await lancar(segunda, produto, 1);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('CORE_INSUFFICIENT_STOCK');
    // A frase precisa dizer que TEM na gaveta e está prometida — senão o
    // mecânico vai olhar a prateleira, ver a peça, e achar o sistema quebrado.
    expect(res.body.error.message).toContain('prometida');
    expect(gaveta(produto)).toEqual({ quantity: 1, reserved: 1 });
  });
});

describe('a decisão do cliente move a gaveta', () => {
  it('APROVOU: a reserva vira baixa, e a peça sai de verdade', async () => {
    const { customerId, token } = await clienteComPortal();
    const orderId = await osAssumida(customerId);
    const produto = await peca('Motor 1000W', 4);
    expect((await lancar(orderId, produto, 1)).status).toBe(201);
    expect(gaveta(produto)).toEqual({ quantity: 4, reserved: 1 });

    expect(
      (
        await request(app)
          .post(`/api/v1/core/workshop/orders/${orderId}/pedir-aprovacao`)
          .set(gerente)
          .send({ workshopId })
      ).status,
    ).toBeLessThan(300);

    const decisao = await request(app)
      .post(`/api/v1/loja/portal/ordens/${orderId}/aprovar`)
      .set(P(token));
    expect(decisao.status).toBe(200);

    // AGORA a peça saiu: o serviço foi autorizado a acontecer.
    expect(gaveta(produto)).toEqual({ quantity: 3, reserved: 0 });
    const linhas = razao(produto);
    expect(linhas.some((l) => l.movement_type === 'out' && l.quantity === -1)).toBe(true);
  });

  it('RECUSOU: a peça volta sozinha para a gaveta', async () => {
    const { customerId, token } = await clienteComPortal();
    const orderId = await osAssumida(customerId);
    const produto = await peca('Chicote completo', 5);
    expect((await lancar(orderId, produto, 3)).status).toBe(201);

    await request(app)
      .post(`/api/v1/core/workshop/orders/${orderId}/pedir-aprovacao`)
      .set(gerente)
      .send({ workshopId });

    const decisao = await request(app)
      .post(`/api/v1/loja/portal/ordens/${orderId}/recusar`)
      .set(P(token));
    expect(decisao.status).toBe(200);

    // É O CORAÇÃO DA RODADA: ninguém precisou lembrar de devolver.
    expect(gaveta(produto)).toEqual({ quantity: 5, reserved: 0 });
    const solta = razao(produto).filter((l) => l.movement_type === 'release');
    expect(solta).toHaveLength(1);
    expect(solta[0].kind).toBe('WORKSHOP_PART_RESERVATION_RELEASE');
    expect(solta[0].reserved_delta).toBe(-3);
    // E o físico nunca foi tocado: a peça não saiu e não voltou, ela ficou.
    expect(razao(produto).some((l) => l.movement_type === 'out')).toBe(false);
  });

  it('aprovar duas vezes não baixa duas vezes', async () => {
    const { customerId, token } = await clienteComPortal();
    const orderId = await osAssumida(customerId);
    const produto = await peca('Pneu traseiro', 4);
    expect((await lancar(orderId, produto, 2)).status).toBe(201);
    await request(app)
      .post(`/api/v1/core/workshop/orders/${orderId}/pedir-aprovacao`)
      .set(gerente)
      .send({ workshopId });

    for (let vez = 0; vez < 2; vez += 1) {
      const r = await request(app)
        .post(`/api/v1/loja/portal/ordens/${orderId}/aprovar`)
        .set(P(token));
      expect(r.status).toBe(200);
    }

    expect(gaveta(produto)).toEqual({ quantity: 2, reserved: 0 });
    expect(razao(produto).filter((l) => l.movement_type === 'out')).toHaveLength(1);
  });
});

/**
 * O CLIENTE MUDA DE IDEIA — e é aqui que a rodada quase deixou um buraco.
 *
 * A recusa solta a promessa, mas NÃO tira a peça da conta da OS: a oficina
 * liga, o cliente volta atrás, e o serviço acontece. Se o consumo olhasse só
 * o estado "prometida", essa peça sairia da loja COBRADA e NUNCA baixada —
 * mercadoria entregue que o estoque segue contando na prateleira, para
 * sempre, sem nada apontando o motivo. É o pior defeito possível num estoque,
 * porque não dói na hora: dói na contagem, meses depois.
 */
describe('a peça que ficou na conta depois da recusa ainda sai da gaveta', () => {
  it('recusar e depois concluir: a peça baixa, e baixa UMA vez', async () => {
    const { customerId, token } = await clienteComPortal();
    const orderId = await osAssumida(customerId);
    const produto = await peca('Controlador reserva', 5);
    expect((await lancar(orderId, produto, 2)).status).toBe(201);

    await request(app)
      .post(`/api/v1/core/workshop/orders/${orderId}/pedir-aprovacao`)
      .set(gerente)
      .send({ workshopId });
    expect(
      (await request(app).post(`/api/v1/loja/portal/ordens/${orderId}/recusar`).set(P(token)))
        .status,
    ).toBe(200);

    // A promessa caiu — e a peça continua na conta do cliente.
    expect(gaveta(produto)).toEqual({ quantity: 5, reserved: 0 });
    const conta = getConnection()
      .prepare('SELECT parts_cents FROM core_service_orders WHERE id = ?')
      .get(orderId) as { parts_cents: number };
    expect(conta.parts_cents).toBeGreaterThan(0);

    // O cliente voltou atrás e o serviço aconteceu.
    const fim = await request(app)
      .post(`/api/v1/core/workshop/orders/${orderId}/complete`)
      .set(mecanico)
      .send({ diagnosis: 'Cliente autorizou por telefone', hasCost: true, forcarChecklist: true });
    expect(fim.status, JSON.stringify(fim.body)).toBe(200);

    // A peça saiu de verdade: cobrada e baixada, que é o par correto.
    expect(gaveta(produto)).toEqual({ quantity: 3, reserved: 0 });
    expect(razao(produto).filter((l) => l.movement_type === 'out')).toHaveLength(1);
  });

  it('devolver peça de orçamento recusado NÃO inventa estoque', async () => {
    const { customerId, token } = await clienteComPortal();
    const orderId = await osAssumida(customerId);
    const produto = await peca('Pastilha reserva', 6);
    expect((await lancar(orderId, produto, 2)).status).toBe(201);
    const partId = linhaDaPeca(orderId);

    await request(app)
      .post(`/api/v1/core/workshop/orders/${orderId}/pedir-aprovacao`)
      .set(gerente)
      .send({ workshopId });
    await request(app).post(`/api/v1/loja/portal/ordens/${orderId}/recusar`).set(P(token));
    expect(gaveta(produto)).toEqual({ quantity: 6, reserved: 0 });

    const volta = await request(app)
      .post(`/api/v1/core/workshop/orders/${orderId}/parts/${partId}/return`)
      .set(mecanico)
      .send({ quantity: 2, reason: 'cliente recusou' });
    expect(volta.status).toBe(200);

    // A peça NUNCA saiu da prateleira. Dar entrada aqui criaria uma segunda,
    // e o estoque passaria a afirmar 8 onde existem 6.
    expect(gaveta(produto)).toEqual({ quantity: 6, reserved: 0 });
    expect(razao(produto).some((l) => l.movement_type === 'in' && l.kind === 'WORKSHOP_PART_RETURN'))
      .toBe(false);
    // E o cliente deixa de ser cobrado por ela.
    const conta = getConnection()
      .prepare('SELECT parts_cents FROM core_service_orders WHERE id = ?')
      .get(orderId) as { parts_cents: number };
    expect(conta.parts_cents).toBe(0);
  });
});

describe('o fechamento consome o que sobrou prometido', () => {
  it('a conclusão técnica baixa a peça da OS que nunca pediu aprovação', async () => {
    const orderId = await osAssumida();
    const produto = await peca('Pastilha de freio', 10);
    expect((await lancar(orderId, produto, 4)).status).toBe(201);
    expect(gaveta(produto)).toEqual({ quantity: 10, reserved: 4 });

    const fim = await request(app)
      .post(`/api/v1/core/workshop/orders/${orderId}/complete`)
      .set(mecanico)
      .send({ diagnosis: 'Troca de pastilhas', hasCost: true, forcarChecklist: true });
    expect(fim.status, JSON.stringify(fim.body)).toBe(200);

    // O serviço aconteceu: a peça está dentro da moto, não na prateleira.
    expect(gaveta(produto)).toEqual({ quantity: 6, reserved: 0 });
  });

  it('o pagamento não baixa de novo o que a conclusão já baixou', async () => {
    const orderId = await osAssumida();
    const produto = await peca('Rolamento', 8);
    expect((await lancar(orderId, produto, 2)).status).toBe(201);
    const conclusao = await request(app)
      .post(`/api/v1/core/workshop/orders/${orderId}/complete`)
      .set(mecanico)
      .send({ diagnosis: 'Trocado', hasCost: true, forcarChecklist: true });
    expect(conclusao.status, JSON.stringify(conclusao.body)).toBe(200);
    expect(gaveta(produto)).toEqual({ quantity: 6, reserved: 0 });

    const pago = await request(app)
      .post(`/api/v1/core/workshop/orders/${orderId}/checkout`)
      .set(caixa)
      .send({ payments: [{ method: 'dinheiro', amountCents: 18000 }] });
    expect(pago.status, JSON.stringify(pago.body)).toBeLessThan(300);

    // A dupla baixa é o erro mais caro deste fluxo, e o razão o impede.
    expect(gaveta(produto)).toEqual({ quantity: 6, reserved: 0 });
    expect(razao(produto).filter((l) => l.movement_type === 'out')).toHaveLength(1);
  });
});

describe('devolver peça — os dois tempos, porque são dois fatos diferentes', () => {
  it('devolver o que ainda está PROMETIDO só solta a promessa', async () => {
    const orderId = await osAssumida();
    const produto = await peca('Parafuso M6', 20);
    expect((await lancar(orderId, produto, 5)).status).toBe(201);
    const partId = linhaDaPeca(orderId);
    expect(gaveta(produto)).toEqual({ quantity: 20, reserved: 5 });

    const volta = await request(app)
      .post(`/api/v1/core/workshop/orders/${orderId}/parts/${partId}/return`)
      .set(mecanico)
      .send({ quantity: 2, reason: 'sobrou' });
    expect(volta.status).toBe(200);

    expect(gaveta(produto)).toEqual({ quantity: 20, reserved: 3 });
    // Uma ENTRADA aqui seria mentira: a peça nunca saiu da prateleira.
    expect(razao(produto).some((l) => l.movement_type === 'in' && l.quantity > 0
      && l.kind === 'WORKSHOP_PART_RETURN')).toBe(false);
  });

  it('devolver o que JÁ SAIU é entrada de verdade', async () => {
    const orderId = await osAssumida();
    const produto = await peca('Cabo de freio', 9);
    expect((await lancar(orderId, produto, 3)).status).toBe(201);
    const partId = linhaDaPeca(orderId);

    await request(app)
      .post(`/api/v1/core/workshop/orders/${orderId}/complete`)
      .set(mecanico)
      .send({ diagnosis: 'Feito', hasCost: true, forcarChecklist: true });
    expect(gaveta(produto)).toEqual({ quantity: 6, reserved: 0 });

    const volta = await request(app)
      .post(`/api/v1/core/workshop/orders/${orderId}/parts/${partId}/return`)
      .set(mecanico)
      .send({ quantity: 1, reason: 'não usou' });
    expect(volta.status).toBe(200);

    expect(gaveta(produto)).toEqual({ quantity: 7, reserved: 0 });
    expect(razao(produto).some((l) => l.kind === 'WORKSHOP_PART_RETURN')).toBe(true);
  });
});

/**
 * A CONCILIAÇÃO PRECISA CONHECER QUEM RESERVA.
 *
 * O relatório compara `core_stock.reserved` com as origens abertas e grita
 * "reserva sem origem" quando sobra promessa sem dono. Só que a lista de
 * origens tinha UMA linha: pedido da loja online. Pré-venda e locação já
 * reservavam e já eram acusadas — e a oficina, que passa a reservar agora,
 * seria a terceira. Alarme que dispara sozinho é alarme que se aprende a
 * ignorar, e aí ele para de servir para o dia em que a divergência é real.
 */
describe('a conciliação de reserva enxerga quem reserva', () => {
  it('OS com peça prometida NÃO é acusada de reserva sem origem', async () => {
    const orderId = await osAssumida();
    const produto = await peca('Farol', 4);
    expect((await lancar(orderId, produto, 1)).status).toBe(201);
    // Sem esta linha o caso passaria com reserva NENHUMA — e provaria nada.
    expect(gaveta(produto).reserved).toBe(1);

    const rel = inventoryReconciliation(companyId);
    const acusacoes = rel.issues.filter((i) => i.productId === produto);
    expect(acusacoes).toEqual([]);
    expect(rel.healthy).toBe(true);
  });

  it('reserva que sobrou sem OS nenhuma continua sendo acusada', async () => {
    const produto = await peca('Guidão', 4);
    // Promessa órfã, escrita direto na gaveta: é exatamente o que o relatório
    // existe para achar, e ele não pode ficar cego por causa da rodada.
    getConnection()
      .prepare('UPDATE core_stock SET reserved = 2 WHERE company_id = ? AND product_id = ?')
      .run(companyId, produto);

    const rel = inventoryReconciliation(companyId);
    expect(rel.issues.some(
      (i) => i.productId === produto && i.check === 'STOCK_RESERVATION_WITHOUT_SOURCE',
    )).toBe(true);
  });
});
