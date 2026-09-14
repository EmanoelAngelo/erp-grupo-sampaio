/**
 * ============================================================================
 * AUDITORIA FASE 9 — A OFICINA DE VERDADE, DO CPF AO DINHEIRO NO FINANCEIRO
 * ============================================================================
 *
 * A Oficina é EMPRESA, não módulo da PJ Motors — e este arquivo prova o fluxo
 * inteiro dentro dela, com matemática exata em centavos:
 *
 *   cliente (CPF válido) -> equipamento com plaquinha -> OS aberta -> orçamento
 *   (1 peça da gaveta + mão de obra) -> pedido de aprovação -> aprovação do
 *   cliente (pelo PORTAL; o "sim por telefone" ganhou porta própria no balcão
 *   — POST .../decidir-orcamento, provada mais abaixo, com autoria e
 *   auditoria de quem atendeu) -> peça RESERVADA e depois BAIXADA UMA vez ->
 *   kanban andando -> conclusão técnica -> fila do caixa -> checkout no PDV
 *   da Oficina -> venda + UM lançamento financeiro liquidado -> OS finalizada
 *   com a linha do tempo completa.
 *
 * OS ACHADOS DESTE ARQUIVO (nasceram vermelhos; consertados, viram travas):
 *
 *   1. `setLabor` NÃO tinha guarda de OS finalizada. `addPart` recusava com
 *      CORE_ORDER_CLOSED, a devolução com CORE_ORDER_FINISHED, foto e plano
 *      recusavam — e a mão de obra passava: o mecânico reescrevia
 *      `labor_cents` e `total_cents` de uma OS JÁ PAGA, e a OS divergia da
 *      venda e do financeiro que ela mesma gerou. Hoje é 409
 *      CORE_ORDER_CLOSED, o padrão dos vizinhos.
 *
 *   2. Mexer no orçamento DEPOIS do aprovado não invalidava `approved_at`.
 *      O próprio serviço documentava a regra ("Manter a aprovação velha seria
 *      cobrar R$ 900 com o aceite dos R$ 300" — pedirAprovacaoOrcamento), mas
 *      só o RE-PEDIDO apagava a aprovação: `setLabor` (e `addPart`) mudava o
 *      total com a OS dizendo "aprovada". Hoje a alteração de valor DERRUBA a
 *      aprovação (volta a orçamento pendente, com a queda registrada na linha
 *      do tempo) — coerente com o reorçar explícito, e o menos disruptivo
 *      para a bancada.
 *
 *   3. Aprovação pelo BALCÃO não existia: só o portal decidia, e o aceite por
 *      telefone morria sem `approved_at` e sem autoria. A rota nova reusa a
 *      MESMA decisão do portal e acrescenta a fala da loja e a auditoria.
 *
 * O que já está coberto em outros arquivos (conferido, não repetido):
 *   - reserva/solta/repromessa da peça: reserva-da-oficina.test.ts e
 *     reorcar-promete-de-novo.test.ts;
 *   - SLA, relógio de coluna e filtros do quadro: kanban-com-sla.test.ts e
 *     os-de-verdade.test.ts ("filtra por situação");
 *   - checkout idempotente e UM lançamento financeiro: workshops-equipment;
 *   - peça de bancada fora da vitrine/locação/pré-venda: peca-fora-da-venda;
 *   - CPF inválido recusado no cadastro: cadastro-fecha-o-ciclo.test.ts.
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
import { loginForTest } from './helpers/auth.js';

const app = createApp();

const EMPRESA_OFICINA = 'oficina-a9';
const EMPRESA_PJ = 'pjmotors-a9';
/** CPF que fecha o módulo 11 — o cadastro valida os dígitos. */
const CPF_VALIDO = '529.982.247-25';

let gerente: { Authorization: string };
let mecanico: { Authorization: string };
let caixa: { Authorization: string };
let gerentePj: { Authorization: string };
let oficinaId: string;
let pjId: string;
let workshopId: string;
let seq = 0;

const P = (token: string) => ({ 'x-portal-token': token });

beforeEach(async () => {
  resetDbForTests();
  seq = 0;

  const g = await loginForTest(app, {
    userId: 'ger-a9',
    companyId: EMPRESA_OFICINA,
    profileCodes: ['gerente_oficina'],
  });
  gerente = { Authorization: `Bearer ${g.body.accessToken}` };
  oficinaId = g.body.company.id;

  const m = await loginForTest(app, {
    userId: 'mec-a9',
    companyId: EMPRESA_OFICINA,
    profileCodes: ['mecanico'],
  });
  mecanico = { Authorization: `Bearer ${m.body.accessToken}` };

  const c = await loginForTest(app, {
    userId: 'cx-a9',
    companyId: EMPRESA_OFICINA,
    profileCodes: ['operador_caixa_oficina'],
  });
  caixa = { Authorization: `Bearer ${c.body.accessToken}` };

  // A OUTRA empresa do grupo — a PJ Motors. O fluxo inteiro acontece na
  // Oficina; a PJ existe aqui para provar que nada vaza para ela.
  const pj = await loginForTest(app, {
    userId: 'ger-pj-a9',
    companyId: EMPRESA_PJ,
    profileCodes: ['gerente_loja'],
  });
  gerentePj = { Authorization: `Bearer ${pj.body.accessToken}` };
  pjId = pj.body.company.id;

  workshopId = 'wk-a9';
  getConnection()
    .prepare(
      `INSERT INTO core_workshops (id, company_id, slug, name, kind, active, created_at)
       VALUES (?, ?, 'mob-a9', 'Bancada A9', 'mobility', 1, ?)`,
    )
    .run(workshopId, oficinaId, new Date().toISOString());
});

/** Peça cadastrada PELA ROTA DO BALCÃO da oficina, com entrada documentada. */
async function pecaNaGaveta(nome: string, qtd: number, precoCents: number): Promise<string> {
  seq += 1;
  const res = await request(app)
    .post('/api/v1/core/workshop/parts')
    .set(gerente)
    .set('idempotency-key', `peca-a9-${seq}`)
    .send({
      workshopId,
      name: nome,
      costCents: 4000,
      priceCents: precoCents,
      quantity: qtd,
      documento: { numero: `NF-A9-${seq}` },
    });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body.productId as string;
}

function gaveta(companyId: string, productId: string): { quantity: number; reserved: number } {
  const row = getConnection()
    .prepare('SELECT quantity, reserved FROM core_stock WHERE company_id = ? AND product_id = ?')
    .get(companyId, productId) as { quantity: number; reserved: number } | undefined;
  return { quantity: row?.quantity ?? 0, reserved: row?.reserved ?? 0 };
}

function saidas(productId: string): { quantity: number }[] {
  return getConnection()
    .prepare(
      `SELECT quantity FROM core_stock_movements
        WHERE company_id = ? AND product_id = ? AND movement_type = 'out'
        ORDER BY created_at, rowid`,
    )
    .all(oficinaId, productId) as unknown as { quantity: number }[];
}

function linhaDaOS(osId: string): Record<string, unknown> {
  return getConnection()
    .prepare('SELECT * FROM core_service_orders WHERE id = ?')
    .get(osId) as Record<string, unknown>;
}

/** Cliente de verdade, com CPF válido e portal confirmado. */
async function clienteComPortal(): Promise<{ customerId: string; token: string }> {
  seq += 1;
  const email = `dono-a9-${seq}@exemplo.com`;
  const criado = await request(app)
    .post('/api/v1/core/customers')
    .set(gerente)
    .send({ name: 'Ednaldo Pereira', document: CPF_VALIDO, email, phone: '96 99999-0000' });
  expect(criado.status, JSON.stringify(criado.body)).toBe(201);
  const customerId = String(criado.body.id);

  const r = await request(app)
    .post('/api/v1/loja/portal/registrar')
    .send({ termsAccepted: true, email, document: CPF_VALIDO, password: 'Portal@2026' });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
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

async function osAssumida(customerId?: string, equipmentId?: string): Promise<string> {
  const os = await request(app)
    .post('/api/v1/core/workshop/orders')
    .set(gerente)
    .send({
      workshopId,
      customerId,
      equipmentId,
      customerName: customerId ? undefined : 'Cliente Balcão',
      complaint: 'Não liga',
    });
  expect(os.status, JSON.stringify(os.body)).toBe(201);
  const assumida = await request(app)
    .post(`/api/v1/core/workshop/orders/${os.body.id}/assume`)
    .set(mecanico)
    .send({ status: 'em_andamento', comment: 'assumindo o serviço' });
  expect(assumida.status, JSON.stringify(assumida.body)).toBe(200);
  return os.body.id as string;
}

/** OS com 1 peça (12.990) e mão de obra (15.000), concluída — na fila do caixa. */
async function osAguardandoPagamento(): Promise<{
  osId: string;
  productId: string;
  totalCents: number;
}> {
  const osId = await osAssumida();
  const productId = await pecaNaGaveta(`Rolamento A9-${seq}`, 4, 12990);
  const lancada = await request(app)
    .post(`/api/v1/core/workshop/orders/${osId}/parts`)
    .set(mecanico)
    .send({ productId, quantity: 1 });
  expect(lancada.status, JSON.stringify(lancada.body)).toBe(201);
  await request(app)
    .post(`/api/v1/core/workshop/orders/${osId}/labor`)
    .set(mecanico)
    .send({ laborCents: 15000 })
    .expect(200);
  const fim = await request(app)
    .post(`/api/v1/core/workshop/orders/${osId}/complete`)
    .set(mecanico)
    .send({ diagnosis: 'Rolamento trocado', hasCost: true, forcarChecklist: true });
  expect(fim.status, JSON.stringify(fim.body)).toBe(200);
  expect(fim.body.status).toBe('aguardando_pagamento');
  return { osId, productId, totalCents: 12990 + 15000 };
}

/** A mesma OS, já paga no PDV da oficina e finalizada. */
async function osFinalizada(): Promise<{ osId: string; productId: string; totalCents: number }> {
  const cenario = await osAguardandoPagamento();
  const pago = await request(app)
    .post(`/api/v1/core/workshop/orders/${cenario.osId}/checkout`)
    .set(caixa)
    .send({ payments: [{ method: 'dinheiro', amountCents: cenario.totalCents }] });
  expect(pago.status, JSON.stringify(pago.body)).toBe(201);
  expect(pago.body.order.status).toBe('finalizada');
  return cenario;
}

// ============================================================================

describe('o fluxo inteiro da oficina, em centavos exatos', () => {
  it('do CPF do cliente ao dinheiro liquidado no financeiro da OFICINA', async () => {
    // 1. Cliente com CPF válido (o inválido já é recusado — coberto em
    //    cadastro-fecha-o-ciclo.test.ts) e portal confirmado.
    const { customerId, token } = await clienteComPortal();

    // 2. O equipamento do cliente entra com plaquinha (#ID público).
    const eq = await request(app).post('/api/v1/core/equipment').set(gerente).send({
      workshopId,
      origin: 'EXTERNAL_CUSTOMER',
      ownerCustomerId: customerId,
      brand: 'Shineray',
      model: 'PT2',
    });
    expect(eq.status, JSON.stringify(eq.body)).toBe(201);
    expect(Number(eq.body.public_id)).toBeGreaterThan(0);
    expect(String(eq.body.publicIdLabel)).toMatch(/^#\d+/);
    const equipmentId = eq.body.id as string;

    // 3. OS aberta com a queixa, amarrada ao cliente e ao equipamento.
    const os = await request(app)
      .post('/api/v1/core/workshop/orders')
      .set(gerente)
      .send({ workshopId, customerId, equipmentId, complaint: 'Não liga' });
    expect(os.status, JSON.stringify(os.body)).toBe(201);
    expect(os.body.status).toBe('em_aberto');
    const osId = os.body.id as string;

    await request(app)
      .post(`/api/v1/core/workshop/orders/${osId}/assume`)
      .set(mecanico)
      .send({ status: 'em_andamento', comment: 'assumindo o serviço' })
      .expect(200);

    // 4. A peça nasce NA GAVETA DA OFICINA, pela rota do balcão: 5 unidades.
    const produto = await pecaNaGaveta('Controlador 48V A9', 5, 12990);
    expect(gaveta(oficinaId, produto)).toEqual({ quantity: 5, reserved: 0 });
    // E NUNCA na PJ Motors: empresa distinta, gaveta distinta.
    expect(gaveta(pjId, produto)).toEqual({ quantity: 0, reserved: 0 });

    // 5. Orçamento: 2 peças + mão de obra. 2 × 12.990 + 15.000 = 40.980.
    const lancada = await request(app)
      .post(`/api/v1/core/workshop/orders/${osId}/parts`)
      .set(mecanico)
      .send({ productId: produto, quantity: 2 });
    expect(lancada.status, JSON.stringify(lancada.body)).toBe(201);
    // A peça lançada RESERVA — não baixa (a doutrina completa mora em
    // reserva-da-oficina.test.ts; aqui se prova que o fluxo passa por ela).
    expect(gaveta(oficinaId, produto)).toEqual({ quantity: 5, reserved: 2 });

    await request(app)
      .post(`/api/v1/core/workshop/orders/${osId}/labor`)
      .set(mecanico)
      .send({ laborCents: 15000 })
      .expect(200);
    expect(Number(linhaDaOS(osId).parts_cents)).toBe(25980);
    expect(Number(linhaDaOS(osId).total_cents)).toBe(40980);

    // 6. A oficina PEDE a aprovação…
    const pedido = await request(app)
      .post(`/api/v1/core/workshop/orders/${osId}/pedir-aprovacao`)
      .set(gerente)
      .send({ workshopId });
    expect(pedido.status, JSON.stringify(pedido.body)).toBe(200);
    expect(linhaDaOS(osId).approval_requested_at).toBeTruthy();

    // …e o CLIENTE decide. (Aqui, no portal dele; o registro do "sim por
    // telefone" pelo balcão tem caso próprio mais abaixo.)
    const decisao = await request(app)
      .post(`/api/v1/loja/portal/ordens/${osId}/aprovar`)
      .set(P(token));
    expect(decisao.status, JSON.stringify(decisao.body)).toBe(200);
    expect(linhaDaOS(osId).approved_at).toBeTruthy();

    // 7. A aprovação CONSOME a promessa: baixa definitiva de 2, UMA vez.
    expect(gaveta(oficinaId, produto)).toEqual({ quantity: 3, reserved: 0 });
    expect(saidas(produto)).toEqual([{ quantity: -2 }]);

    // 8. O kanban anda com observação, e o quadro entrega régua e filtro.
    await request(app)
      .post(`/api/v1/core/workshop/orders/${osId}/move`)
      .set(mecanico)
      .send({ status: 'aguardando_peca', comment: 'esperando o parafuso especial' })
      .expect(200);
    const quadro = await request(app)
      .get('/api/v1/core/workshop/orders?status=aguardando_peca')
      .set(mecanico);
    expect(quadro.status).toBe(200);
    const card = (quadro.body.items as { id: string; status_changed_at: string | null }[]).find(
      (i) => i.id === osId,
    );
    expect(card, 'o filtro por status do quadro não devolveu a OS parada').toBeTruthy();
    // O relógio da coluna e a régua do SLA vêm JUNTO do quadro — é com eles
    // que a tela acusa OS parada (a régua em si é medida em kanban-com-sla).
    expect(card!.status_changed_at).toBeTruthy();
    expect(quadro.body.sla).toBeTruthy();
    expect(quadro.body.statuses).toContain('aguardando_pagamento');

    await request(app)
      .post(`/api/v1/core/workshop/orders/${osId}/move`)
      .set(mecanico)
      .send({ status: 'em_andamento', comment: 'peça chegou, montando' })
      .expect(200);

    // 9. Conferência de entrada respondida (sem atalho de forçar).
    const check = await request(app)
      .get(`/api/v1/core/workshop/orders/${osId}/checklist`)
      .set(mecanico);
    expect(check.status).toBe(200);
    for (const item of check.body.items as { id: string }[]) {
      await request(app)
        .patch(`/api/v1/core/workshop/orders/${osId}/checklist/${item.id}`)
        .set(mecanico)
        .send({ answer: 'sim' })
        .expect(200);
    }

    // 10. Conclusão técnica: com custo, a OS vai para a fila do caixa.
    const fim = await request(app)
      .post(`/api/v1/core/workshop/orders/${osId}/complete`)
      .set(mecanico)
      .send({ diagnosis: 'Controlador substituído e testado', hasCost: true });
    expect(fim.status, JSON.stringify(fim.body)).toBe(200);
    expect(fim.body.status).toBe('aguardando_pagamento');
    // A conclusão NÃO baixa de novo o que a aprovação já baixou.
    expect(gaveta(oficinaId, produto)).toEqual({ quantity: 3, reserved: 0 });
    expect(saidas(produto)).toEqual([{ quantity: -2 }]);

    // 11. O caixa da oficina vê a OS na fila…
    const fila = await request(app).get('/api/v1/core/workshop/pending-payment').set(caixa);
    expect(fila.status).toBe(200);
    expect((fila.body.items as { id: string }[]).map((i) => i.id)).toContain(osId);

    // 12. …e recebe EXATAMENTE 40.980 em dinheiro no PDV da Oficina.
    const pago = await request(app)
      .post(`/api/v1/core/workshop/orders/${osId}/checkout`)
      .set(caixa)
      .send({ payments: [{ method: 'dinheiro', amountCents: 40980 }] });
    expect(pago.status, JSON.stringify(pago.body)).toBe(201);
    expect(pago.body.order.status).toBe('finalizada');
    expect(pago.body.order.paid_at).toBeTruthy();
    expect(pago.body.order.sale_id).toBeTruthy();
    const saleId = pago.body.sale.id as string;

    const db = getConnection();

    // A venda é o fato econômico único: 40.980, sem troco, NA OFICINA.
    const venda = db
      .prepare(
        'SELECT company_id, total_cents, discount_cents, change_cents FROM core_sales WHERE id = ?',
      )
      .get(saleId) as {
      company_id: string;
      total_cents: number;
      discount_cents: number;
      change_cents: number;
    };
    expect(venda.company_id).toBe(oficinaId);
    expect(venda.total_cents).toBe(40980);
    expect(venda.discount_cents).toBe(0);
    expect(venda.change_cents).toBe(0);

    /*
      A VENDA SAI ITEMIZADA — duas frentes, uma conta só.

      GAP-PRD-024 (FIS): era UMA linha sem produto com os 40.980 — a nota das
      peças não tinha NCM de onde tirar e a mão de obra não tinha documento.
      Agora a peça é linha COM produto (mercadoria, nota) e a mão de obra é a
      linha de serviço (NFS-e).

      GAP-PRD-101 (OFI): a peça leva o custo com que SAIU da gaveta (4.000 no
      cadastro), a mão de obra fica sem custo — é o que leva a oficina ao CMV.

      Nenhuma das duas move estoque de novo: a gaveta abaixo continua como a
      conclusão a deixou.
    */
    const itens = db
      .prepare(
        'SELECT product_id, description, quantity, total_cents, cost_cents FROM core_sale_items WHERE sale_id = ? ORDER BY rowid',
      )
      .all(saleId) as unknown as {
      product_id: string | null;
      description: string;
      quantity: number;
      total_cents: number;
      cost_cents: number | null;
    }[];
    expect(itens.map((i) => [i.product_id, i.quantity, i.total_cents, i.cost_cents])).toEqual([
      [produto, 2, 25980, 4000],
      [null, 1, 15000, null],
    ]);
    expect(itens.reduce((acc, i) => acc + i.total_cents, 0)).toBe(40980);
    expect(itens[1].description).toMatch(/^Mão de obra — OS #\d+$/);

    // O financeiro DA OFICINA recebeu: UM lançamento, liquidado, exato.
    const financeiro = db
      .prepare(
        `SELECT company_id, direction, amount_cents, status, settled_cents
           FROM core_finance_entries WHERE origin_type = 'sale' AND origin_id = ?`,
      )
      .all(saleId) as unknown as {
      company_id: string;
      direction: string;
      amount_cents: number;
      status: string;
      settled_cents: number;
    }[];
    expect(financeiro).toHaveLength(1);
    expect(financeiro[0]).toEqual({
      company_id: oficinaId,
      direction: 'in',
      amount_cents: 40980,
      status: 'settled',
      settled_cents: 40980,
    });

    // A baixa continua sendo UMA: pagar não rebaixa estoque.
    expect(gaveta(oficinaId, produto)).toEqual({ quantity: 3, reserved: 0 });
    expect(saidas(produto)).toEqual([{ quantity: -2 }]);
    // E a PJ Motors terminou o dia como começou: sem esta peça, sem esta venda.
    expect(gaveta(pjId, produto)).toEqual({ quantity: 0, reserved: 0 });
    const vendasPj = db
      .prepare('SELECT COUNT(*) AS n FROM core_sales WHERE company_id = ?')
      .get(pjId) as { n: number };
    expect(vendasPj.n).toBe(0);

    // 13. A linha do tempo conta a história inteira, na ordem.
    const eventos = db
      .prepare(
        `SELECT from_status, to_status FROM core_service_order_events
          WHERE order_id = ? ORDER BY created_at, rowid`,
      )
      .all(osId) as unknown as { from_status: string | null; to_status: string }[];
    expect(eventos.map((e) => [e.from_status, e.to_status])).toEqual([
      [null, 'em_aberto'],
      ['em_aberto', 'em_andamento'],
      ['em_andamento', 'aguardando_peca'],
      ['aguardando_peca', 'em_andamento'],
      ['em_andamento', 'aguardando_pagamento'],
      ['aguardando_pagamento', 'finalizada'],
    ]);

    const detalhe = await request(app).get(`/api/v1/core/workshop/orders/${osId}`).set(caixa);
    expect(detalhe.status).toBe(200);
    expect(detalhe.body.customer_display).toBe('Ednaldo Pereira');
    expect(Number(detalhe.body.equipment_public_id)).toBe(Number(eq.body.public_id));
    const falas = (detalhe.body.comments as { body: string; author_kind: string }[]) ?? [];
    // GAP-PRD-036: a fala não diz mais "enviado" — diz que espera o cliente,
    // e por onde o aviso foi (ou que o cliente não tem e-mail).
    expect(falas.some((f) => f.body.includes('aguardando aprovação do cliente'))).toBe(true);
    expect(
      falas.some((f) => f.author_kind === 'proprietario' && f.body.includes('APROVADO')),
    ).toBe(true);
    expect(falas.some((f) => f.body.includes('Controlador substituído'))).toBe(true);
  });
});

describe('OS finalizada não muda de conta', () => {
  it('peça nova em OS finalizada é 409, e a gaveta não anda', async () => {
    const { osId } = await osFinalizada();
    const outra = await pecaNaGaveta('Pastilha A9', 3, 5000);

    const res = await request(app)
      .post(`/api/v1/core/workshop/orders/${osId}/parts`)
      .set(mecanico)
      .send({ productId: outra, quantity: 1 });
    expect(res.status, JSON.stringify(res.body)).toBe(409);
    expect(res.body.error?.code).toBe('CORE_ORDER_CLOSED');
    expect(gaveta(oficinaId, outra)).toEqual({ quantity: 3, reserved: 0 });
  });

  it('devolver peça de OS finalizada é 409 — o custo já virou faturamento', async () => {
    const { osId, productId } = await osFinalizada();
    const partId = (
      getConnection()
        .prepare('SELECT id FROM core_service_order_parts WHERE order_id = ? LIMIT 1')
        .get(osId) as { id: string }
    ).id;

    const res = await request(app)
      .post(`/api/v1/core/workshop/orders/${osId}/parts/${partId}/return`)
      .set(mecanico)
      .send({ quantity: 1, reason: 'tentativa tardia' });
    expect(res.status, JSON.stringify(res.body)).toBe(409);
    expect(res.body.error?.code).toBe('CORE_ORDER_FINISHED');
    expect(gaveta(oficinaId, productId)).toEqual({ quantity: 3, reserved: 0 });
  });

  /**
   * >>> ACHADO DA AUDITORIA (nasceu vermelho; consertado) <<<
   *
   * `setLabor` (WorkshopCoreService) não olhava o status da OS. Toda porta
   * vizinha tinha guarda — `addPart` (CORE_ORDER_CLOSED), a devolução
   * (CORE_ORDER_FINISHED), `moveOrder`, `setOrderPlan`, a foto — e a mão de
   * obra passava: o técnico responsável reescrevia `labor_cents` e o
   * `recalculateTotals` reescrevia `total_cents` de uma OS FINALIZADA E PAGA.
   * O estrago: a OS dizia um total, a venda e o financeiro gerados por ela
   * diziam outro — sem erro, sem rastro, num POST que respondia 200.
   *
   * Hoje `setLabor` recusa com CORE_ORDER_CLOSED, o padrão dos vizinhos, e
   * este caso é a trava de regressão.
   */
  it('mão de obra de OS finalizada e PAGA não muda — setLabor ganhou a guarda dos vizinhos', async () => {
    const { osId, totalCents } = await osFinalizada();
    const antes = linhaDaOS(osId);
    expect(Number(antes.labor_cents)).toBe(15000);
    expect(Number(antes.total_cents)).toBe(totalCents);

    const res = await request(app)
      .post(`/api/v1/core/workshop/orders/${osId}/labor`)
      .set(mecanico)
      .send({ laborCents: 100 });
    expect(
      res.status,
      'OS finalizada e paga aceitou alteração de mão de obra — setLabor não tem guarda de status',
    ).toBe(409);

    const depois = linhaDaOS(osId);
    expect(Number(depois.labor_cents), 'labor_cents reescrito numa OS paga').toBe(15000);
    expect(Number(depois.total_cents), 'total_cents divergiu da venda já cobrada').toBe(totalCents);
  });

  /**
   * >>> ACHADO DA AUDITORIA (nasceu vermelho; consertado) <<<
   *
   * A regra estava escrita no próprio serviço (pedirAprovacaoOrcamento):
   * "Manter a aprovação velha seria cobrar R$ 900 com o aceite dos R$ 300".
   * Mas só o RE-PEDIDO apagava `approved_at`. Mudar o orçamento por fora —
   * `setLabor` aqui; `addPart` tinha o mesmo buraco — mudava `total_cents` e
   * deixava a aprovação de pé: a OS seguia "aprovada" com um total que o
   * cliente nunca viu, e o checkout cobrava o valor novo.
   *
   * A asserção é o INVARIANTE, não um conserto específico: ou a mudança é
   * recusada (total fica o aprovado), ou a aprovação cai junto. O conserto
   * escolhido foi DERRUBAR — o menos disruptivo para a bancada: o serviço
   * continua, a conta fica certa, e a OS volta a "orçamento pendente" com a
   * queda dita na linha do tempo (conferida aqui também).
   */
  it('orçamento aprovado não vira outro valor com a aprovação de pé', async () => {
    const { customerId, token } = await clienteComPortal();
    const osId = await osAssumida(customerId);
    const produto = await pecaNaGaveta('Chicote A9', 2, 12990);
    await request(app)
      .post(`/api/v1/core/workshop/orders/${osId}/parts`)
      .set(mecanico)
      .send({ productId: produto, quantity: 1 })
      .expect(201);
    await request(app)
      .post(`/api/v1/core/workshop/orders/${osId}/labor`)
      .set(mecanico)
      .send({ laborCents: 15000 })
      .expect(200);
    await request(app)
      .post(`/api/v1/core/workshop/orders/${osId}/pedir-aprovacao`)
      .set(gerente)
      .send({ workshopId })
      .expect(200);
    await request(app).post(`/api/v1/loja/portal/ordens/${osId}/aprovar`).set(P(token)).expect(200);

    const totalAprovado = Number(linhaDaOS(osId).total_cents);
    expect(totalAprovado).toBe(27990);

    // A oficina mexe na mão de obra DEPOIS do sim do cliente.
    await request(app)
      .post(`/api/v1/core/workshop/orders/${osId}/labor`)
      .set(mecanico)
      .send({ laborCents: 90000 });

    const os = linhaDaOS(osId);
    const aprovadaAindaVale = os.approved_at !== null;
    const totalContinuaOAprovado = Number(os.total_cents) === totalAprovado;
    expect(
      aprovadaAindaVale && !totalContinuaOAprovado,
      `a OS está marcada como aprovada (approved_at=${String(os.approved_at)}) com total `
        + `${String(os.total_cents)} diferente do aprovado ${totalAprovado} — o aceite velho `
        + 'passou a cobrir um valor que o cliente nunca viu',
    ).toBe(false);

    // O conserto escolhido foi DERRUBAR: a aprovação caiu junto com o pedido
    // (a OS volta a orçamento em edição), e a linha do tempo registra a queda
    // — é o que a oficina lê antes de pedir o aceite de novo.
    expect(os.approved_at).toBeNull();
    expect(os.approval_requested_at).toBeNull();
    const detalhe = await request(app).get(`/api/v1/core/workshop/orders/${osId}`).set(gerente);
    expect(detalhe.status).toBe(200);
    const falas = (detalhe.body.comments as { body: string }[]) ?? [];
    expect(
      falas.some((f) => f.body.includes('requer novo aceite')),
      'a queda da aprovação não ficou dita na linha do tempo',
    ).toBe(true);
  });
});

describe('o aceite por telefone tem porta no balcão', () => {
  /**
   * >>> ACHADO DA AUDITORIA (nasceu vermelho; consertado) <<<
   *
   * Aprovação pelo BALCÃO não existia: só o portal decidia
   * (`decidirOrcamento`), e o "sim" que chega por telefone — metade dos
   * aceites da oficina — morria sem `approved_at` e sem autoria: o balcão só
   * conseguia registrá-lo concluindo o serviço, e a OS aprovada por telefone
   * ficava indistinguível da nunca aprovada.
   *
   * A rota nova (POST /core/workshop/orders/:id/decidir-orcamento) REUSA a
   * decisão do portal — mesma pendência conferida, mesma baixa de promessa,
   * mesma idempotência — e acrescenta o que faltava: a fala de quem atendeu o
   * telefone na linha do tempo (voz da LOJA, não do proprietário) e a
   * AUDITORIA de quem registrou.
   */
  it('o balcão registra o "sim" do telefone: approved_at preenche, a peça baixa UMA vez e a autoria fica', async () => {
    // Cliente cadastrado, SEM portal: é exatamente quem aprova por telefone.
    const criado = await request(app)
      .post('/api/v1/core/customers')
      .set(gerente)
      .send({ name: 'Ednaldo do Telefone', document: CPF_VALIDO, phone: '96 98888-1111' });
    expect(criado.status, JSON.stringify(criado.body)).toBe(201);
    const customerId = String(criado.body.id);

    const osId = await osAssumida(customerId);
    const produto = await pecaNaGaveta('Guidão A9', 3, 12990);
    await request(app)
      .post(`/api/v1/core/workshop/orders/${osId}/parts`)
      .set(mecanico)
      .send({ productId: produto, quantity: 1 })
      .expect(201);
    await request(app)
      .post(`/api/v1/core/workshop/orders/${osId}/labor`)
      .set(mecanico)
      .send({ laborCents: 15000 })
      .expect(200);
    await request(app)
      .post(`/api/v1/core/workshop/orders/${osId}/pedir-aprovacao`)
      .set(gerente)
      .send({ workshopId })
      .expect(200);
    expect(linhaDaOS(osId).approved_at).toBeNull();
    expect(gaveta(oficinaId, produto)).toEqual({ quantity: 3, reserved: 1 });

    // O telefone toca, o cliente diz sim — e o gerente REGISTRA.
    const decisao = await request(app)
      .post(`/api/v1/core/workshop/orders/${osId}/decidir-orcamento`)
      .set(gerente)
      .send({ approved: true, note: 'ligação das 14h, aceitou os R$ 279,90' });
    expect(
      decisao.status,
      `o balcão não tem como registrar o aceite por telefone: ${JSON.stringify(decisao.body)}`,
    ).toBe(200);

    // O aceite é o MESMO do portal: approved_at preenchido e a promessa
    // consumida — baixa definitiva de 1, UMA vez.
    expect(linhaDaOS(osId).approved_at).toBeTruthy();
    expect(gaveta(oficinaId, produto)).toEqual({ quantity: 2, reserved: 0 });
    expect(saidas(produto)).toEqual([{ quantity: -1 }]);

    // A autoria fica: quem atendeu assina na linha do tempo com a voz da
    // LOJA — a fala 'proprietario' continua sendo só do portal.
    const detalhe = await request(app).get(`/api/v1/core/workshop/orders/${osId}`).set(gerente);
    expect(detalhe.status).toBe(200);
    const falas = (detalhe.body.comments as { body: string; author_kind: string; author_name: string }[]) ?? [];
    const registro = falas.find(
      (f) => f.author_kind === 'gestor' && f.body.includes('registrado pelo balcão'),
    );
    expect(registro, 'o aceite por telefone não deixou autoria na linha do tempo').toBeTruthy();
    expect(registro!.author_name).toBe('ger-a9');
    expect(registro!.body).toContain('ligação das 14h');

    // E a AUDITORIA diz quem registrou o quê.
    const auditoria = getConnection()
      .prepare(
        `SELECT user_id, detail FROM core_audit_log
          WHERE company_id = ? AND action = 'workshop.order.budget_decision' AND entity_id = ?`,
      )
      .get(oficinaId, osId) as { user_id: string; detail: string } | undefined;
    expect(auditoria, 'o aceite por telefone precisa de trilha de auditoria').toBeTruthy();
    expect(JSON.parse(auditoria!.detail).approved).toBe(true);

    // Registrar o mesmo sim de novo é clique repetido, não segunda baixa.
    await request(app)
      .post(`/api/v1/core/workshop/orders/${osId}/decidir-orcamento`)
      .set(gerente)
      .send({ approved: true })
      .expect(200);
    expect(gaveta(oficinaId, produto)).toEqual({ quantity: 2, reserved: 0 });
    expect(saidas(produto)).toEqual([{ quantity: -1 }]);
  });
});

/*
  A PORTA DE DESCONTO ABRIU — e com a alçada do balcão (GAP-PRD-104).

  Este bloco se chamava "o fechamento da OS não tem porta de desconto" e
  cobrava que `discountCents` fosse IGNORADO. Era verdade e era o defeito: o
  caixa da oficina não tinha como dar o desconto que o balcão da loja dá, e
  recorria a gambiarra. Agora o desconto entra pela MESMA alçada de
  `createSale` — acima do limite, 403 pedindo gestor; nada acontece até lá.
  O resto da prova (nada nasce na recusa, o valor exato fecha) continua.
*/
describe('o desconto no fechamento da OS passa pela alçada do balcão', () => {
  it('desconto acima do limite do caixa pede gestor, sem nascer venda; pagar a menos sem desconto é recusado em centavos', async () => {
    const { osId, totalCents } = await osAguardandoPagamento();

    // R$ 50,00 sobre R$ 279,90 são 17,86% — acima dos 10% do caixa.
    const res = await request(app)
      .post(`/api/v1/core/workshop/orders/${osId}/checkout`)
      .set(caixa)
      .send({
        discountCents: 5000,
        payments: [{ method: 'dinheiro', amountCents: totalCents - 5000 }],
      });
    expect(res.status, JSON.stringify(res.body)).toBe(403);
    expect(res.body.error?.code).toBe('CORE_DISCOUNT_NEEDS_AUTHORIZATION');
    expect(res.body.error?.details?.concedidoCents).toBe(5000);

    // Sem desconto, pagar a menos continua sendo buraco dito em centavos.
    const amenos = await request(app)
      .post(`/api/v1/core/workshop/orders/${osId}/checkout`)
      .set(caixa)
      .send({ payments: [{ method: 'dinheiro', amountCents: totalCents - 5000 }] });
    expect(amenos.status, JSON.stringify(amenos.body)).toBe(400);
    expect(amenos.body.error?.code).toBe('CORE_PAYMENT_MISMATCH');
    expect(amenos.body.error?.details?.missing).toBe(5000);

    // Nada aconteceu: a OS segue na fila e nenhuma venda nasceu.
    expect(String(linhaDaOS(osId).status)).toBe('aguardando_pagamento');
    const vendas = getConnection()
      .prepare('SELECT COUNT(*) AS n FROM core_sales WHERE company_id = ?')
      .get(oficinaId) as { n: number };
    expect(vendas.n).toBe(0);

    // E o valor EXATO fecha.
    const certo = await request(app)
      .post(`/api/v1/core/workshop/orders/${osId}/checkout`)
      .set(caixa)
      .send({ payments: [{ method: 'dinheiro', amountCents: totalCents }] });
    expect(certo.status, JSON.stringify(certo.body)).toBe(201);
    expect(certo.body.sale.total_cents).toBe(totalCents);
  });
});

describe('a gaveta da Oficina é da Oficina — a PJ Motors não vê nem vende', () => {
  it('a peça não aparece na listagem, na busca do PDV, nem fecha venda na PJ Motors', async () => {
    const produto = await pecaNaGaveta('Bateria 72V A9', 4, 89900);
    expect(gaveta(oficinaId, produto)).toEqual({ quantity: 4, reserved: 0 });

    // Listagem da bancada na PJ Motors: vazia — a peça é da OUTRA empresa.
    const listaPj = await request(app).get('/api/v1/core/workshop/parts').set(gerentePj);
    expect(listaPj.status).toBe(200);
    expect((listaPj.body.items as { id: string }[]).map((i) => i.id)).not.toContain(produto);

    // Busca do PDV da PJ Motors, mesmo pedindo as peças de bancada: nada.
    const busca = await request(app)
      .get('/api/v1/core/products/search?q=Bateria%2072V%20A9&includeParts=1')
      .set(gerentePj);
    expect(busca.status).toBe(200);
    expect((busca.body.items as { id: string }[]).map((i) => i.id)).not.toContain(produto);

    // Vender a peça da Oficina no balcão da PJ Motors: produto não existe LÁ.
    const venda = await request(app)
      .post('/api/v1/core/sales')
      .set(gerentePj)
      .set('idempotency-key', 'venda-cruzada-a9')
      .send({
        items: [{ productId: produto, quantity: 1 }],
        payments: [{ method: 'dinheiro', amountCents: 89900 }],
      });
    expect(venda.status, JSON.stringify(venda.body)).toBe(404);
    expect(venda.body.error?.code).toBe('CORE_PRODUCT_NOT_FOUND');

    // A gaveta da Oficina não sentiu nada, e a PJ não ganhou saldo do nada.
    expect(gaveta(oficinaId, produto)).toEqual({ quantity: 4, reserved: 0 });
    expect(gaveta(pjId, produto)).toEqual({ quantity: 0, reserved: 0 });
  });
});
