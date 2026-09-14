/**
 * O PÓS-VENDA NO PORTAL (GAP-PRD-125): a nota da compra, o link de rastreio e
 * o pedido de devolução — com a loja decidindo do outro lado.
 *
 * A auditoria mediu o portal parando no "Entregue": o DANFE só no ERP (a loja
 * mandava por e-mail à mão), o rastreio como texto e a devolução só "falando
 * com a loja", embora a vitrine anuncie "Troca em 7 dias" (CDC, art. 49).
 *
 * A nota usada aqui é emitida pelo caminho real do pedido (`emitNfeForOrder`)
 * em modo de desenvolvimento — o adaptador de teste da SEFAZ, sem rede.
 */
process.env.TZ = 'UTC';

import { beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { resetDbForTests } from '../src/db/database.js';
import { getConnection } from '../src/db/sqlite.js';
import {
  linkUserToCompany,
  upsertCompany,
  upsertUser,
} from '../src/services/auth/IdentityService.js';
import { updateFiscalConfig } from '../src/services/core/FiscalConfigService.js';
import { setSeriesNextNumber } from '../src/services/core/FiscalKeyService.js';
import { emitNfeForOrder } from '../src/services/core/OrderInvoiceService.js';
import { advanceFulfillment } from '../src/services/core/StorefrontService.js';
import { confirmarEmail } from '../src/services/core/CustomerPortalService.js';
import { hojeNaLoja, somarDias } from '../src/services/core/CalendarioOperacional.js';
import { grupoTributarioPadrao } from './helpers/grupoTributario.js';
import { textoDeEntrega } from '../src/services/notifications/EmailService.js';

const app = createApp();
const SENHA_ERP = 'Teste@PosVenda2026';
const SENHA_PORTAL = 'senha-do-cliente-2026';
const EMAIL = 'joana@exemplo.com';

let companyId: string;
let gestor: { Authorization: string };
let token: string;
let contaId: string;
let numero = 0;

function agora(): string {
  return new Date().toISOString();
}

async function contaDoPortal(email: string): Promise<{ token: string; accountId: string }> {
  const res = await request(app)
    .post('/api/v1/loja/portal/registrar')
    .send({ termsAccepted: true, email, password: SENHA_PORTAL });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  const linha = getConnection()
    .prepare(
      `SELECT id FROM core_email_queue
        WHERE template = 'verificacao_email' AND to_address = ?
        ORDER BY created_at DESC LIMIT 1`,
    )
    .get(email) as { id: string } | undefined;
  const codigo = (linha ? textoDeEntrega(linha.id) : null)?.match(/é: (\d{6})/)?.[1];
  expect(codigo, 'código de verificação ausente').toBeTruthy();
  confirmarEmail({ accountId: res.body.account.id as string, codigo });
  return { token: res.body.token as string, accountId: res.body.account.id as string };
}

/** Pedido PAGO da conta, de retirada, com cadastro e endereço fiscal. */
function pedidoDaConta(accountId: string): string {
  numero += 1;
  const db = getConnection();
  const produto = `prod-pv-${numero}`;
  db.prepare(
    `INSERT INTO core_products (id, company_id, internal_code, name, unit, cost_cents,
                                price_cents, ncm, cfop, origin, active, created_at, updated_at)
     VALUES (?, ?, ?, 'Camisa Online', 'UN', 1000, 5000, '62052000', '5102', '0', 1, ?, ?)`,
  ).run(produto, companyId, `PV-${numero}`, agora(), agora());
  const cliente = randomUUID();
  db.prepare(
    `INSERT INTO core_customers (id, company_id, name, document, email, active, created_at, updated_at)
     VALUES (?, ?, 'Joana Compradora', '11144477735', ?, 1, ?, ?)`,
  ).run(cliente, companyId, EMAIL, agora(), agora());
  const id = `pedido-pv-${numero}`;
  db.prepare(
    `INSERT INTO core_orders
       (id, company_id, number, customer_id, customer_name, customer_email, customer_document,
        shipping_zip, shipping_address, shipping_method, shipping_cents, items_cents, total_cents,
        status, payment_method, paid_at, customer_account_id, idempotency_key, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'Joana Compradora', ?, '11144477735', '68900000',
             'Rua das Flores, 250 - Central', 'retirada', 0, 10000, 10000,
             'pago', 'pix', ?, ?, ?, ?, ?)`,
  ).run(id, companyId, numero, cliente, EMAIL, agora(), accountId, `k-${id}`, agora(), agora());
  db.prepare(
    `INSERT INTO core_order_items (id, order_id, company_id, product_id, description,
                                   quantity, unit_price_cents, total_cents)
     VALUES (?, ?, ?, ?, 'Camisa Online', 2, 5000, 10000)`,
  ).run(`oi-pv-${numero}`, id, companyId, produto);
  return id;
}

function entregar(orderId: string) {
  for (const etapa of ['separacao', 'conferencia', 'embalado', 'pronto_para_retirada', 'entregue']) {
    advanceFulfillment({ companyId, orderId, toStatus: etapa });
  }
}

function detalhe(orderId: string, t = token) {
  return request(app).get(`/api/v1/loja/portal/pedidos/${orderId}`).set('x-portal-token', t);
}

function pedirDevolucao(orderId: string, body: Record<string, unknown>, t = token) {
  return request(app)
    .post(`/api/v1/loja/portal/pedidos/${orderId}/devolucao`)
    .set('x-portal-token', t)
    .send(body);
}

function decidir(orderId: string, requestId: string, body: Record<string, unknown>, quem = gestor) {
  return request(app)
    .post(`/api/v1/core/orders/${orderId}/devolucao/solicitacoes/${requestId}/decidir`)
    .set(quem)
    .send(body);
}

beforeEach(async () => {
  resetDbForTests();
  numero = 0;
  companyId = upsertCompany({ slug: 'gringa', legalName: 'Gringa Comércio Ltda', tradeName: 'Gringa' });
  updateFiscalConfig({
    companyId,
    patch: {
      legalName: 'Gringa Comércio Ltda',
      cnpj: '11.222.333/0001-81',
      ie: '123456789',
      crt: '1',
      // O CEP do emitente é exigido desde o XSD oficial (GAP-PRD-097): sem ele a NF-e é bloqueada.
      zip: '96010000',
      street: 'Av. Central',
      number: '100',
      district: 'Centro',
      cityName: 'Pelotas',
      cityIbge: '4314407',
      uf: 'RS',
    },
  });
  grupoTributarioPadrao(companyId);
  setSeriesNextNumber({ companyId, model: '55', serie: 1, nextNumber: 1 });

  const userId = await upsertUser({ login: 'GESTOR.PV', displayName: 'Gestor', password: SENHA_ERP });
  linkUserToCompany(userId, companyId, 'gerente_loja', true);
  const login = await request(app).post('/api/v1/auth/login').send({ login: 'GESTOR.PV', password: SENHA_ERP });
  gestor = { Authorization: `Bearer ${login.body.accessToken}` };

  const conta = await contaDoPortal(EMAIL);
  token = conta.token;
  contaId = conta.accountId;
  // O destinatário da NF-e sai do endereço fiscal da conta (com IBGE).
  getConnection()
    .prepare(
      `INSERT INTO core_customer_addresses
         (id, account_id, label, zip, street, number, complement, district, city, state,
          city_ibge, is_default, created_at, updated_at)
       VALUES (?, ?, 'Casa', '68900000', 'Rua das Flores', '250', NULL, 'Central', 'Macapá', 'AP',
               '1600303', 1, ?, ?)`,
    )
    .run(randomUUID(), contaId, agora(), agora());
});

// ============================================================================

describe('a nota fiscal da compra, para a dona do pedido', () => {
  it('antes de emitir: o detalhe diz que não há nota, e o DANFE responde 404 com o motivo', async () => {
    const id = pedidoDaConta(contaId);
    const res = await detalhe(id);
    expect(res.status).toBe(200);
    expect(res.body.notaFiscal).toBeNull();
    const danfe = await request(app).get(`/api/v1/loja/portal/pedidos/${id}/nfe/danfe`).set('x-portal-token', token);
    expect(danfe.status, danfe.text).toBe(404);
    expect(danfe.body.error?.code, danfe.text).toBe('PORTAL_NFE_INDISPONIVEL');
  });

  it('emitida: o detalhe mostra número e situação; o DANFE abre e o XML autorizado baixa', async () => {
    const id = pedidoDaConta(contaId);
    const emitida = await emitNfeForOrder({ companyId, orderId: id, developmentMode: true });
    expect(emitida.document.status).toBe('AUTHORIZED');

    const res = await detalhe(id);
    expect(res.body.notaFiscal).toMatchObject({
      numero: 1,
      status: 'AUTHORIZED',
      statusLabel: 'Autorizada',
      danfe: true,
      xml: true,
    });
    expect(res.body.notaFiscal.chave).toMatch(/^\d{44}$/);

    const danfe = await request(app).get(`/api/v1/loja/portal/pedidos/${id}/nfe/danfe`).set('x-portal-token', token);
    expect(danfe.status).toBe(200);
    expect(danfe.headers['content-type']).toMatch(/text\/html/);
    expect(danfe.text).toContain('DANFE');

    const xml = await request(app).get(`/api/v1/loja/portal/pedidos/${id}/nfe/xml`).set('x-portal-token', token);
    expect(xml.status).toBe(200);
    expect(xml.headers['content-type']).toMatch(/application\/xml/);
    expect(xml.headers['content-disposition']).toContain(`NFe-${res.body.notaFiscal.chave}.xml`);
    expect(xml.text).toContain('<nfeProc');
    expect(xml.text).toContain('<protNFe');
  });

  it('a nota de outra pessoa é 404 — detalhe, DANFE, XML e devolução', async () => {
    const id = pedidoDaConta(contaId);
    await emitNfeForOrder({ companyId, orderId: id, developmentMode: true });
    entregar(id);
    const intrusa = await contaDoPortal('intrusa@exemplo.com');
    expect((await detalhe(id, intrusa.token)).status).toBe(404);
    for (const tipo of ['danfe', 'xml']) {
      const r = await request(app).get(`/api/v1/loja/portal/pedidos/${id}/nfe/${tipo}`).set('x-portal-token', intrusa.token);
      expect([tipo, r.status]).toEqual([tipo, 404]);
      expect(r.text).not.toContain('<nfeProc');
    }
    const dev = await pedirDevolucao(id, { tipo: 'defeito', motivo: 'não é meu mas vou tentar' }, intrusa.token);
    expect(dev.status).toBe(404);
    // Sem sessão, nada.
    expect((await request(app).get(`/api/v1/loja/portal/pedidos/${id}/nfe/xml`)).status).toBe(401);
  });
});

// ============================================================================

describe('o rastreio vira link quando o código é dos Correios', () => {
  it('objeto dos Correios ganha o link público; código de outro padrão fica sem link inventado', async () => {
    const id = pedidoDaConta(contaId);
    getConnection().prepare("UPDATE core_orders SET tracking_code = 'br123456789br' WHERE id = ?").run(id);
    expect((await detalhe(id)).body.trackingUrl).toBe(
      'https://rastreamento.correios.com.br/app/index.php?objetos=BR123456789BR',
    );
    getConnection().prepare("UPDATE core_orders SET tracking_code = 'JADLOG-99887' WHERE id = ?").run(id);
    const outro = await detalhe(id);
    expect(outro.body.trackingCode).toBe('JADLOG-99887');
    expect(outro.body.trackingUrl).toBeNull();
  });
});

// ============================================================================

describe('o pedido de devolução pelo portal', () => {
  it('antes de receber o pedido, não dá — e o portal diz por quê', async () => {
    const id = pedidoDaConta(contaId);
    const res = await detalhe(id);
    expect(res.body.devolucao).toMatchObject({
      podeSolicitar: false,
      motivoIndisponivel: 'A devolução pode ser pedida depois que você receber o pedido.',
    });
    const r = await pedirDevolucao(id, { tipo: 'arrependimento', motivo: 'Mudei de ideia sobre a cor' });
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('PORTAL_DEVOLUCAO_INDISPONIVEL');
  });

  it('entregue: abre a solicitação por arrependimento dentro dos 7 dias; a segunda é recusada', async () => {
    const id = pedidoDaConta(contaId);
    entregar(id);
    const antes = await detalhe(id);
    expect(antes.body.devolucao).toMatchObject({
      podeSolicitar: true,
      arrependimentoNoPrazo: true,
      prazoArrependimentoAte: somarDias(hojeNaLoja(), 7),
    });

    const r = await pedirDevolucao(id, { tipo: 'arrependimento', motivo: 'Não serviu, quero devolver' });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body.solicitacao).toMatchObject({ kind: 'arrependimento', status: 'aberta', statusLabel: 'Aguardando a loja' });
    expect(r.body.devolucao.podeSolicitar).toBe(false);

    const segunda = await pedirDevolucao(id, { tipo: 'defeito', motivo: 'Outra tentativa em seguida' });
    expect(segunda.status).toBe(409);
    expect(segunda.body.error.code).toBe('PORTAL_DEVOLUCAO_JA_SOLICITADA');

    const trilha = getConnection()
      .prepare("SELECT COUNT(*) AS n FROM core_audit_log WHERE action = 'order.return_requested' AND entity_id = ?")
      .get(id) as { n: number };
    expect(trilha.n).toBe(1);
    const nota = getConnection()
      .prepare('SELECT note FROM core_order_events WHERE order_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1')
      .get(id) as { note: string };
    expect(nota.note).toMatch(/Cliente pediu devolução pelo portal \(Desistência \(arrependimento\)\): Não serviu/);
  });

  it('tipo e motivo são conferidos no servidor', async () => {
    const id = pedidoDaConta(contaId);
    entregar(id);
    expect((await pedirDevolucao(id, { tipo: 'troca', motivo: 'Motivo com tamanho suficiente' })).body.error.code).toBe(
      'PORTAL_DEVOLUCAO_TIPO',
    );
    expect((await pedirDevolucao(id, { tipo: 'defeito', motivo: 'curto' })).body.error.code).toBe(
      'PORTAL_DEVOLUCAO_MOTIVO',
    );
  });

  it('passados os 7 dias do recebimento, arrependimento é recusado com a data; defeito continua possível', async () => {
    const id = pedidoDaConta(contaId);
    entregar(id);
    const dezDiasAtras = new Date(Date.now() - 10 * 86_400_000).toISOString();
    getConnection()
      .prepare("UPDATE core_order_events SET created_at = ? WHERE order_id = ? AND status = 'entregue'")
      .run(dezDiasAtras, id);

    const tarde = await pedirDevolucao(id, { tipo: 'arrependimento', motivo: 'Desisti depois de dez dias' });
    expect(tarde.status).toBe(409);
    expect(tarde.body.error.code).toBe('PORTAL_DEVOLUCAO_FORA_DO_PRAZO');
    expect(tarde.body.error.message).toMatch(/terminou em \d{2}\/\d{2}\/\d{4}/);

    const defeito = await pedirDevolucao(id, { tipo: 'defeito', motivo: 'A costura abriu no primeiro uso' });
    expect(defeito.status).toBe(201);
  });

  it('a loja vê, decide, e o reembolso conclui — a cliente acompanha cada passo', async () => {
    const id = pedidoDaConta(contaId);
    entregar(id);
    const { body } = await pedirDevolucao(id, { tipo: 'defeito', motivo: 'A costura abriu no primeiro uso' });
    const reqId = body.solicitacao.id as string;

    // A lista marca o pedido que espera decisão; a ficha traz a solicitação.
    const lista = await request(app).get('/api/v1/core/orders').set(gestor);
    expect(lista.body.items.find((o: { id: string }) => o.id === id).return_request_status).toBe('aberta');
    const ficha = await request(app).get(`/api/v1/core/orders/${id}`).set(gestor);
    expect(ficha.body.returnRequests).toHaveLength(1);
    expect(ficha.body.returnRequests[0]).toMatchObject({ id: reqId, kind: 'defeito', reason: 'A costura abriu no primeiro uso' });

    // Recusar sem motivo: a cliente ficaria sem explicação.
    const semNota = await decidir(id, reqId, { decisao: 'recusar' });
    expect(semNota.status).toBe(400);
    expect(semNota.body.error.code).toBe('CORE_RETURN_REQUEST_NOTE');

    const aprovada = await decidir(id, reqId, { decisao: 'aprovar', nota: 'Traga na loja com a etiqueta' });
    expect(aprovada.status, JSON.stringify(aprovada.body)).toBe(200);
    expect(aprovada.body.status).toBe('aprovada');
    expect((await decidir(id, reqId, { decisao: 'recusar', nota: 'mudei de ideia' })).body.error.code).toBe(
      'CORE_RETURN_REQUEST_DECIDED',
    );

    const noPortal = await detalhe(id);
    expect(noPortal.body.devolucao.solicitacoes[0]).toMatchObject({
      status: 'aprovada',
      decisionNote: 'Traga na loja com a etiqueta',
    });

    // O reembolso pelo ERP conclui a solicitação.
    const devolvido = await request(app)
      .post(`/api/v1/core/orders/${id}/devolver`)
      .set(gestor)
      .send({ reason: 'defeito de costura', mercadoriaNaMao: true });
    expect(devolvido.status, JSON.stringify(devolvido.body)).toBe(200);
    const depois = await detalhe(id);
    expect(depois.body.devolucao.solicitacoes[0].status).toBe('concluida');
    expect(depois.body.devolucao).toMatchObject({
      podeSolicitar: false,
      motivoIndisponivel: 'Este pedido já foi devolvido e reembolsado.',
    });

    const trilha = getConnection()
      .prepare("SELECT COUNT(*) AS n FROM core_audit_log WHERE action = 'order.return_request_decided' AND entity_id = ?")
      .get(id) as { n: number };
    expect(trilha.n).toBe(1);
  });

  it('a recusa chega à cliente com o motivo da loja, e a solicitação de outra empresa é 404', async () => {
    const id = pedidoDaConta(contaId);
    entregar(id);
    const { body } = await pedirDevolucao(id, { tipo: 'defeito', motivo: 'Chegou com mancha na manga' });
    const reqId = body.solicitacao.id as string;

    const outra = upsertCompany({ slug: 'vizinha', legalName: 'Vizinha Ltda', tradeName: 'Vizinha' });
    const userId = await upsertUser({ login: 'GESTOR.VIZ', displayName: 'Vizinho', password: SENHA_ERP });
    linkUserToCompany(userId, outra, 'gerente_loja', true);
    const loginViz = await request(app)
      .post('/api/v1/auth/login')
      .send({ login: 'GESTOR.VIZ', password: SENHA_ERP, companyId: outra });
    const vizinho = { Authorization: `Bearer ${loginViz.body.accessToken}` };
    expect((await decidir(id, reqId, { decisao: 'aprovar' }, vizinho)).status).toBe(404);

    const recusada = await decidir(id, reqId, { decisao: 'recusar', nota: 'A mancha é de uso, não de fábrica' });
    expect(recusada.body.status).toBe('recusada');
    const noPortal = await detalhe(id);
    expect(noPortal.body.devolucao.solicitacoes[0]).toMatchObject({
      status: 'recusada',
      statusLabel: 'Recusada pela loja',
      decisionNote: 'A mancha é de uso, não de fábrica',
    });
    // Recusada não trava a cliente: ela pode pedir de novo (outra evidência).
    expect(noPortal.body.devolucao.podeSolicitar).toBe(true);
  });
});
