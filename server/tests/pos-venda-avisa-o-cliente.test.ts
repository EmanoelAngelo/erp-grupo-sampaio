/**
 * ============================================================================
 * O PÓS-VENDA AVISA O CLIENTE (GAP-PRD-037)
 * ============================================================================
 *
 * O QUE ERA: o pedido online só avisava recebido, pago, expedido e pronto
 * para retirada. Um PIX vencido cancelava o pedido de madrugada e o cliente
 * não sabia; reembolso e cancelamento pela loja, em silêncio; o pagamento que
 * caía depois do cancelamento (dinheiro do cliente na conta da empresa) não
 * gerava uma palavra; "entregue" não avisava; e a NF-e autorizada ficava só
 * no sistema — o destinatário nunca recebia o XML nem o DANFE.
 *
 * O QUE ESTE ARQUIVO TRAVA:
 *   - cancelado pelo cliente (rota do portal), pela loja (rota do ERP) e pelo
 *     prazo (a rotina de expiração): cada um com o que o cliente precisa
 *     fazer — sempre o "não pague", e no prazo o como refazer;
 *   - reembolsado: só promete o estorno que existe (confirmado pelo
 *     provedor, pedido ao provedor, contestação, ou a loja devolve à mão);
 *   - pagamento depois do cancelamento: o cliente sabe que foi visto;
 *   - entregue/retirado: avisa, uma vez;
 *   - nota autorizada (produção) de pedido: e-mail com o .zip do XML
 *     autorizado + DANFE, pelo ponto único da autorização
 *     (`FiscalQueueService.processNext`); homologação não vai;
 *   - cada fato, UMA mensagem.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { inflateRawSync } from 'node:zlib';
import { createApp } from '../src/app.js';
import { resetDbForTests } from '../src/db/database.js';
import { ensureCoreSchema } from '../src/db/schema.js';
import { getConnection } from '../src/db/sqlite.js';
import {
  advanceFulfillment,
  cancelOrder,
  checkout,
  markOrderPaid,
  markOrderRefunded,
  registerPaymentAfterCancel,
} from '../src/services/core/StorefrontService.js';
import { refundOrder } from '../src/services/core/OrderChargeService.js';
import {
  expirarPedidosNaoPagos,
  PRAZO_DA_RESERVA_MS,
} from '../src/services/core/OrderReservationExpiry.js';
import { enqueue, processNext } from '../src/services/core/FiscalQueueService.js';
import type { SefazAdapter } from '../src/services/core/SefazAdapter.js';
import { confirmarEmail } from '../src/services/core/CustomerPortalService.js';
import { textoDeEntrega } from '../src/services/notifications/EmailService.js';
import { avisarNotaDoPedido } from '../src/services/notifications/AvisoDaNotaDoPedido.js';
import { loginForTest } from './helpers/auth.js';

const app = createApp();
const EMPRESA = 'gringa-pv';
const CPF = '111.444.777-35';

const EMAIL_VARS = [
  'EMAIL_ENABLED',
  'EMAIL_FROM',
  'EMAIL_SMTP_HOST',
  'EMAIL_SMTP_PORT',
  'EMAIL_SMTP_USER',
  'EMAIL_SMTP_PASSWORD',
] as const;
const originais = new Map<string, string | undefined>();
for (const v of EMAIL_VARS) originais.set(v, process.env[v]);

let gerente: { Authorization: string };
let n = 0;

beforeEach(async () => {
  resetDbForTests();
  ensureCoreSchema();
  n = 0;
  for (const v of EMAIL_VARS) process.env[v] = '';
  process.env.EMAIL_ENABLED = 'false';
  const r = await loginForTest(app, { userId: 'ger-pv', companyId: EMPRESA, profileCodes: ['gerente_loja'] });
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  gerente = { Authorization: `Bearer ${r.body.accessToken as string}` };
});

afterEach(() => {
  for (const v of EMAIL_VARS) {
    const o = originais.get(v);
    if (o === undefined) delete process.env[v];
    else process.env[v] = o;
  }
});

function produto(): string {
  n += 1;
  const id = `pv-${n}`;
  const agora = new Date().toISOString();
  const db = getConnection();
  db.prepare(
    `INSERT INTO core_products (id, company_id, internal_code, name, unit, cost_cents,
                                price_cents, active, publish_online, created_at, updated_at)
     VALUES (?, ?, ?, 'Jaqueta', 'UN', 4000, 10000, 1, 1, ?, ?)`,
  ).run(id, EMPRESA, `PV-${n}`, agora, agora);
  db.prepare(
    'INSERT INTO core_stock (company_id, product_id, quantity, reserved, updated_at) VALUES (?, ?, 30, 0, ?)',
  ).run(EMPRESA, id, agora);
  return id;
}

function comprar(email = 'ana@exemplo.com') {
  n += 1;
  const [pedido] = checkout({
    idempotencyKey: `pv-ck-${n}`,
    customerName: 'Ana Compradora',
    customerEmail: email,
    customerDocument: CPF,
    paymentMethod: 'pix',
    items: [{ productId: produto(), quantity: 1 }],
  });
  return pedido;
}

interface Linha {
  id: string;
  template: string;
  to_address: string;
  subject: string;
  body_text: string;
  anexo_nome: string | null;
  anexo_id: string | null;
}

function mensagens(template: string): Linha[] {
  return getConnection()
    .prepare(
      `SELECT id, template, to_address, subject, body_text, anexo_nome, anexo_id
         FROM core_email_queue WHERE template = ? ORDER BY created_at, rowid`,
    )
    .all(template) as unknown as Linha[];
}

describe('cancelado — quem cancelou muda o que o cliente precisa fazer', () => {
  it('pela LOJA (rota do ERP): avisa, com o "não pague"', async () => {
    const pedido = comprar();
    const r = await request(app)
      .post(`/api/v1/core/orders/${pedido.id}/cancel`)
      .set(gerente)
      .send({ reason: 'Sem estoque na loja física' });
    expect(r.status, JSON.stringify(r.body)).toBe(200);

    const [m] = mensagens('pedido_cancelado');
    expect(m, 'o cancelamento não avisou').toBeTruthy();
    expect(m.to_address).toBe('ana@exemplo.com');
    expect(m.subject).toContain(`pedido #${pedido.number} cancelado`);
    expect(m.body_text).toContain('A loja cancelou o pedido');
    expect(m.body_text).toContain('Não pague o PIX nem o boleto');
    // O motivo digitado pela loja é nota interna: não vai ao cliente.
    expect(m.body_text).not.toContain('Sem estoque na loja física');
  });

  it('pelo PRAZO (PIX vencido, a rotina da madrugada): diz que venceu e como refazer', async () => {
    const pedido = comprar();
    const agora = new Date(Date.now() + PRAZO_DA_RESERVA_MS + 60_000);
    const r = await expirarPedidosNaoPagos(agora);
    expect(r.cancelados).toBe(1);

    const [m] = mensagens('pedido_cancelado');
    expect(m.subject).toContain(`#${pedido.number}`);
    expect(m.body_text).toMatch(/prazo para pagar o pedido #\d+ venceu/);
    expect(m.body_text).toContain('/loja');
    expect(m.body_text).toContain('Não pague');
  });

  it('pelo CLIENTE (rota do portal): confirma o que ele pediu', async () => {
    const pedido = comprar('portal-pv@exemplo.com');
    const conta = await request(app)
      .post('/api/v1/loja/portal/registrar')
      .send({ termsAccepted: true, email: 'portal-pv@exemplo.com', document: CPF, password: 'Portal@2026' });
    expect(conta.status, JSON.stringify(conta.body)).toBe(201);
    const verif = getConnection()
      .prepare(
        `SELECT id FROM core_email_queue WHERE template = 'verificacao_email' AND to_address = ?
          ORDER BY created_at DESC LIMIT 1`,
      )
      .get('portal-pv@exemplo.com') as { id: string };
    const codigo = textoDeEntrega(verif.id)?.match(/é: (\d{6})/)?.[1];
    expect(codigo).toBeTruthy();
    confirmarEmail({ accountId: conta.body.account.id as string, codigo: codigo! });

    const r = await request(app)
      .post(`/api/v1/loja/portal/pedidos/${pedido.id}/cancelar`)
      .set({ 'x-portal-token': conta.body.token as string })
      .send({});
    expect(r.status, JSON.stringify(r.body)).toBe(200);

    const [m] = mensagens('pedido_cancelado');
    expect(m.body_text).toContain('como você pediu');
  });

  it('cancelar de novo não manda outro e-mail', () => {
    const pedido = comprar();
    cancelOrder({ companyId: EMPRESA, orderId: pedido.id, origem: 'loja' });
    cancelOrder({ companyId: EMPRESA, orderId: pedido.id, origem: 'loja' });
    expect(mensagens('pedido_cancelado')).toHaveLength(1);
  });

  it('o pagamento que cai DEPOIS do cancelamento: o cliente sabe que foi visto — uma vez', () => {
    const pedido = comprar();
    cancelOrder({ companyId: EMPRESA, orderId: pedido.id, origem: 'cliente' });
    registerPaymentAfterCancel({ companyId: EMPRESA, orderId: pedido.id, providerRef: 'pay_1', amountCents: 10000 });
    registerPaymentAfterCancel({ companyId: EMPRESA, orderId: pedido.id, providerRef: 'pay_1', amountCents: 10000 });

    const avisos = mensagens('pagamento_apos_cancelamento');
    expect(avisos).toHaveLength(1);
    expect(avisos[0].body_text).toContain('O pagamento de R$ 100,00');
    expect(avisos[0].body_text).toContain('continua cancelado');
    expect(avisos[0].body_text).toContain('devolver o valor');
  });
});

describe('reembolsado — só promete o estorno que existe', () => {
  it('estorno confirmado pelo provedor (webhook refunded)', () => {
    const pedido = comprar();
    markOrderPaid({ companyId: EMPRESA, orderId: pedido.id, provider: 'manual' });
    markOrderRefunded({ companyId: EMPRESA, orderId: pedido.id, reason: 'refunded' });
    markOrderRefunded({ companyId: EMPRESA, orderId: pedido.id, reason: 'refunded' });

    const avisos = mensagens('pedido_reembolsado');
    expect(avisos).toHaveLength(1);
    expect(avisos[0].body_text).toContain('foi estornado');
    expect(avisos[0].body_text).toContain('mesmo meio de pagamento');
  });

  it('devolução pela loja SEM estorno automático: não promete cartão, diz que a loja combina', async () => {
    const pedido = comprar();
    markOrderPaid({ companyId: EMPRESA, orderId: pedido.id, provider: 'manual' });
    const r = await refundOrder({ companyId: EMPRESA, orderId: pedido.id, reason: 'defeito' });
    expect(r.providerRefund).toBe('not_applicable');

    const [m] = mensagens('pedido_reembolsado');
    expect(m.body_text).toContain('não é automático');
    expect(m.body_text).toContain('a loja entra em contato');
    expect(m.body_text).not.toContain('foi estornado');
  });

  it('contestação (chargeback): diz que segue na operadora', () => {
    const pedido = comprar();
    markOrderPaid({ companyId: EMPRESA, orderId: pedido.id, provider: 'manual' });
    markOrderRefunded({ companyId: EMPRESA, orderId: pedido.id, reason: 'chargeback' });
    expect(mensagens('pedido_reembolsado')[0].body_text).toContain('contestado');
  });
});

describe('entregue', () => {
  it('a retirada no balcão avisa "retirado", uma vez, com o link do pedido', () => {
    const pedido = comprar();
    markOrderPaid({ companyId: EMPRESA, orderId: pedido.id, provider: 'manual' });
    for (const etapa of ['separacao', 'conferencia', 'embalado', 'pronto_para_retirada', 'entregue']) {
      advanceFulfillment({ companyId: EMPRESA, orderId: pedido.id, toStatus: etapa });
    }
    const avisos = mensagens('pedido_entregue');
    expect(avisos).toHaveLength(1);
    expect(avisos[0].subject).toContain('retirado');
    expect(avisos[0].body_text).toContain(`/minha-conta/pedidos/${pedido.id}`);
  });
});

// ------------------------------------------------------------ a nota fiscal

const CHAVE = '15260900000000000155550010000001231000001230';

function notaDoPedido(orderId: string, ambiente: 'production' | 'homologation', status = 'QUEUED'): string {
  const id = `doc-${ambiente}-${orderId}`;
  const agora = new Date().toISOString();
  const nfe =
    `<NFe xmlns="http://www.portalfiscal.inf.br/nfe"><infNFe Id="NFe${CHAVE}" versao="4.00">`
    + '<ide><nNF>123</nNF><serie>1</serie></ide>'
    + '<emit><xNome>Gringa Ltda</xNome><CNPJ>00000000000155</CNPJ></emit>'
    + '<dest><xNome>Ana Compradora</xNome><CPF>11144477735</CPF></dest>'
    + '<total><ICMSTot><vNF>100.00</vNF></ICMSTot></total>'
    + '</infNFe><Signature>assinatura</Signature></NFe>';
  getConnection()
    .prepare(
      `INSERT INTO core_fiscal_documents
         (id, company_id, order_id, model, serie, number, access_key, environment, status,
          xml_original, xml_signed, issued_at, created_at, updated_at)
       VALUES (?, ?, ?, '55', 1, 123, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(id, EMPRESA, orderId, ambiente === 'production' ? CHAVE : `${CHAVE.slice(0, -1)}9`, ambiente, status, nfe, nfe, agora, agora, agora);
  return id;
}

const PROTOCOLO =
  '<retEnviNFe><protNFe versao="4.00"><infProt><tpAmb>1</tpAmb>'
  + `<chNFe>${CHAVE}</chNFe><dhRecbto>2026-09-11T10:00:00-03:00</dhRecbto>`
  + '<nProt>115260000012345</nProt><cStat>100</cStat><xMotivo>Autorizado o uso da NF-e</xMotivo>'
  + '</infProt></protNFe></retEnviNFe>';

/** Um adapter de teste que autoriza — injetado, nunca montado pela aplicação. */
const sefazQueAutoriza = {
  authorize: () =>
    Promise.resolve({
      outcome: 'AUTHORIZED',
      protocol: '115260000012345',
      cStat: '100',
      xMotivo: 'Autorizado o uso da NF-e',
      receivedAt: new Date().toISOString(),
      rawResponse: PROTOCOLO,
      correlationId: 'teste',
    }),
  consult: () => Promise.reject(new Error('não usado')),
} as unknown as SefazAdapter;

/** Os nomes dos arquivos dentro do .zip (cabeçalhos locais). */
function arquivosDoZip(zip: Buffer): Map<string, string> {
  const saida = new Map<string, string>();
  let i = 0;
  while (i + 30 <= zip.length && zip.readUInt32LE(i) === 0x04034b50) {
    const metodo = zip.readUInt16LE(i + 8);
    const tamanho = zip.readUInt32LE(i + 18);
    const nomeLen = zip.readUInt16LE(i + 26);
    const extraLen = zip.readUInt16LE(i + 28);
    const nome = zip.subarray(i + 30, i + 30 + nomeLen).toString('utf8');
    const inicio = i + 30 + nomeLen + extraLen;
    const dados = zip.subarray(inicio, inicio + tamanho);
    saida.set(nome, (metodo === 8 ? inflateRawSync(dados) : dados).toString('utf8'));
    i = inicio + tamanho;
  }
  return saida;
}

describe('a nota autorizada do pedido vai ao cliente', () => {
  it('pela autorização (processNext): e-mail com o .zip do XML autorizado e do DANFE, uma vez', async () => {
    const pedido = comprar();
    markOrderPaid({ companyId: EMPRESA, orderId: pedido.id, provider: 'manual' });
    const docId = notaDoPedido(pedido.id, 'production');
    enqueue({ companyId: EMPRESA, documentId: docId });
    const r = await processNext({ companyId: EMPRESA, adapter: sefazQueAutoriza });
    expect(r.status, JSON.stringify(r)).toBe('AUTHORIZED');

    const avisos = mensagens('nota_disponivel');
    expect(avisos).toHaveLength(1);
    const [m] = avisos;
    expect(m.to_address).toBe('ana@exemplo.com');
    expect(m.subject).toContain(`nota fiscal do pedido #${pedido.number}`);
    expect(m.body_text).toContain('NF-e nº 123');
    expect(m.body_text).toContain('autorizada pela SEFAZ');
    expect(m.anexo_nome).toMatch(/NF-e 123 - pedido \d+\.zip/);
    expect(m.anexo_id).toBeTruthy();

    const bytes = getConnection()
      .prepare('SELECT conteudo FROM core_email_attachments WHERE id = ?')
      .get(m.anexo_id) as { conteudo: Uint8Array };
    const zip = arquivosDoZip(Buffer.from(bytes.conteudo));
    const xml = zip.get(`${CHAVE}-procNFe.xml`);
    expect(xml, [...zip.keys()].join(',')).toBeTruthy();
    expect(xml).toContain('<nfeProc');
    expect(xml).toContain('<nProt>115260000012345</nProt>');
    expect(zip.get('DANFE-NFe-123.html')).toContain('DANFE');

    // Repetir a pergunta não gera outro e-mail.
    expect(avisarNotaDoPedido(EMPRESA, docId)).toBeNull();
    expect(mensagens('nota_disponivel')).toHaveLength(1);
  });

  it('nota de HOMOLOGAÇÃO não vai: não tem valor fiscal', () => {
    const pedido = comprar();
    const docId = notaDoPedido(pedido.id, 'homologation', 'AUTHORIZED');
    getConnection()
      .prepare('UPDATE core_fiscal_documents SET xml_authorized = ?, protocol = ? WHERE id = ?')
      .run(PROTOCOLO, '115260000012345', docId);
    expect(avisarNotaDoPedido(EMPRESA, docId)).toBeNull();
    expect(mensagens('nota_disponivel')).toHaveLength(0);
  });

  it('protocolo sem nProt (rejeição disfarçada): nada de "sua nota" sem nota', () => {
    const pedido = comprar();
    const docId = notaDoPedido(pedido.id, 'production', 'AUTHORIZED');
    getConnection()
      .prepare('UPDATE core_fiscal_documents SET xml_authorized = ?, protocol = ? WHERE id = ?')
      .run('<protNFe><infProt><cStat>539</cStat></infProt></protNFe>', 'x', docId);
    expect(avisarNotaDoPedido(EMPRESA, docId)).toBeNull();
    expect(mensagens('nota_disponivel')).toHaveLength(0);
  });
});
