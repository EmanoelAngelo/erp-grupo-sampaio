/**
 * ============================================================================
 * A OFICINA AVISA O CLIENTE (GAP-PRD-036)
 * ============================================================================
 *
 * O QUE ERA: "Enviar orçamento ao cliente" gravava `approval_requested_at` e
 * uma fala interna — nenhuma mensagem, nenhum modelo de OS na fila. A tela
 * dizia "enviado em …" e o cliente só sabia do orçamento se abrisse o portal
 * por conta própria. Pronta e concluída, também em silêncio.
 *
 * O QUE ESTE ARQUIVO TRAVA:
 *   - pedir a aprovação põe na fila o orçamento (valor + caminho do portal),
 *     e a linha do tempo diz para quem foi — ou que o cliente não tem e-mail;
 *   - reorçar avisa de novo; o mesmo valor pedido de novo, não;
 *   - conclusão com custo avisa "pronta" com o valor; sem custo, "concluída";
 *     paga no caixa, "finalizada";
 *   - a fila quebrada não desfaz o pedido de aprovação;
 *   - a rota de avisos da OS conta a verdade, e OS de outra empresa é 404;
 *   - com credencial, o carteiro entrega.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { resetDbForTests } from '../src/db/database.js';
import { getConnection } from '../src/db/sqlite.js';
import {
  flushEmailQueue,
  type CarteiroSmtp,
  type MensagemSmtp,
} from '../src/services/notifications/EmailService.js';
import { loginForTest } from './helpers/auth.js';

const app = createApp();
const EMPRESA = 'oficina-avisa';
const OUTRA = 'pj-avisa';
/** CPF que fecha o módulo 11 — o cadastro valida os dígitos. */
const CPF = '529.982.247-25';

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
let mecanico: { Authorization: string };
let caixa: { Authorization: string };
let gerenteOutra: { Authorization: string };
let workshopId: string;
let seq = 0;

async function token(userId: string, companyId: string, perfil: string) {
  const r = await loginForTest(app, { userId, companyId, profileCodes: [perfil] });
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return { Authorization: `Bearer ${r.body.accessToken as string}` };
}

beforeEach(async () => {
  resetDbForTests();
  seq = 0;
  // Sem credencial: nada sai daqui por acidente (o .env do dono pode ter).
  for (const v of EMAIL_VARS) process.env[v] = '';
  process.env.EMAIL_ENABLED = 'false';
  gerente = await token('ger-avisa', EMPRESA, 'gerente_oficina');
  mecanico = await token('mec-avisa', EMPRESA, 'mecanico');
  caixa = await token('cx-avisa', EMPRESA, 'operador_caixa_oficina');
  gerenteOutra = await token('ger-outra', OUTRA, 'gerente_oficina');
  workshopId = 'wk-avisa';
  getConnection()
    .prepare(
      `INSERT INTO core_workshops (id, company_id, slug, name, kind, active, created_at)
       VALUES (?, ?, 'mob-avisa', 'Bancada Avisa', 'mobility', 1, ?)`,
    )
    .run(workshopId, EMPRESA, new Date().toISOString());
});

afterEach(() => {
  for (const v of EMAIL_VARS) {
    const o = originais.get(v);
    if (o === undefined) delete process.env[v];
    else process.env[v] = o;
  }
});

async function cliente(email: string | null): Promise<string> {
  seq += 1;
  const r = await request(app)
    .post('/api/v1/core/customers')
    .set(gerente)
    .send({ name: `Ednaldo ${seq}`, document: CPF, ...(email ? { email } : {}), phone: '96 99999-0000' });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return String(r.body.id);
}

async function osAssumida(customerId: string): Promise<string> {
  const os = await request(app)
    .post('/api/v1/core/workshop/orders')
    .set(gerente)
    .send({ workshopId, customerId, equipment: 'Scooter X', complaint: 'Não liga' });
  expect(os.status, JSON.stringify(os.body)).toBe(201);
  const assumida = await request(app)
    .post(`/api/v1/core/workshop/orders/${os.body.id}/assume`)
    .set(mecanico)
    .send({ status: 'em_andamento', comment: 'assumindo o serviço' });
  expect(assumida.status, JSON.stringify(assumida.body)).toBe(200);
  return String(os.body.id);
}

async function maoDeObra(osId: string, cents: number): Promise<void> {
  const r = await request(app)
    .post(`/api/v1/core/workshop/orders/${osId}/labor`)
    .set(mecanico)
    .send({ laborCents: cents });
  expect(r.status, JSON.stringify(r.body)).toBe(200);
}

async function pedirAprovacao(osId: string) {
  const r = await request(app)
    .post(`/api/v1/core/workshop/orders/${osId}/pedir-aprovacao`)
    .set(gerente)
    .send({});
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return r;
}

interface LinhaDaFila {
  id: string;
  template: string;
  to_address: string;
  subject: string;
  body_text: string;
  status: string;
}

function fila(template?: string): LinhaDaFila[] {
  return getConnection()
    .prepare(
      `SELECT id, template, to_address, subject, body_text, status FROM core_email_queue
        WHERE company_id = ? ${template ? 'AND template = ?' : ''} ORDER BY created_at, rowid`,
    )
    .all(...(template ? [EMPRESA, template] : [EMPRESA])) as unknown as LinhaDaFila[];
}

function falas(osId: string): string[] {
  return (
    getConnection()
      .prepare('SELECT body FROM core_service_order_comments WHERE order_id = ? ORDER BY created_at, rowid')
      .all(osId) as { body: string }[]
  ).map((f) => f.body);
}

describe('o orçamento chega ao cliente', () => {
  it('pedir a aprovação põe na fila o valor e o caminho do portal — e a linha do tempo diz para quem', async () => {
    const osId = await osAssumida(await cliente('dono-avisa@exemplo.com'));
    await maoDeObra(osId, 15000);
    await pedirAprovacao(osId);

    const [msg] = fila('os_orcamento_disponivel');
    expect(msg, 'o orçamento não entrou na fila').toBeTruthy();
    expect(msg.to_address).toBe('dono-avisa@exemplo.com');
    expect(msg.subject).toMatch(/orçamento da OS #\d+ para aprovar/);
    expect(msg.body_text).toContain('R$ 150,00');
    expect(msg.body_text).toContain('/minha-conta/equipamentos');
    expect(msg.body_text).toContain('Scooter X');
    expect(msg.status).toBe('pending');

    // A fala não diz mais "enviado": diz por onde o aviso foi.
    const fala = falas(osId).find((f) => f.includes('aguardando aprovação do cliente'));
    expect(fala).toContain('Aviso por e-mail para dono-avisa@exemplo.com');
    expect(falas(osId).some((f) => f.includes('enviado para aprovação'))).toBe(false);

    // A rota da OS conta o mesmo — e que o envio ainda não está ligado.
    const avisos = await request(app)
      .get(`/api/v1/core/workshop/orders/${osId}/avisos`)
      .set(gerente);
    expect(avisos.status, JSON.stringify(avisos.body)).toBe(200);
    expect(avisos.body.emailDoCliente).toBe('dono-avisa@exemplo.com');
    expect(avisos.body.envioLigado).toBe(false);
    expect(avisos.body.avisos).toHaveLength(1);
    expect(avisos.body.avisos[0]).toMatchObject({
      template: 'os_orcamento_disponivel',
      templateLabel: 'Orçamento da OS para aprovar',
      status: 'pending',
    });
  });

  it('cliente sem e-mail: nada na fila, e a linha do tempo manda avisar por telefone', async () => {
    const osId = await osAssumida(await cliente(null));
    await maoDeObra(osId, 9000);
    await pedirAprovacao(osId);

    expect(fila()).toHaveLength(0);
    expect(falas(osId).some((f) => f.includes('Cliente sem e-mail cadastrado: avise por telefone'))).toBe(true);

    const avisos = await request(app)
      .get(`/api/v1/core/workshop/orders/${osId}/avisos`)
      .set(mecanico);
    expect(avisos.status).toBe(200);
    expect(avisos.body.emailDoCliente).toBeNull();
    expect(avisos.body.avisos).toEqual([]);
  });

  it('reorçar avisa de novo com o valor novo; o mesmo valor pedido de novo não duplica', async () => {
    const osId = await osAssumida(await cliente('reorca@exemplo.com'));
    await maoDeObra(osId, 15000);
    await pedirAprovacao(osId);
    // O clique repetido, com o cliente ainda sem responder e o mesmo valor.
    await pedirAprovacao(osId);
    expect(fila('os_orcamento_disponivel')).toHaveLength(1);

    // A oficina mexe no orçamento e pede de novo: é outro orçamento.
    await maoDeObra(osId, 22000);
    await pedirAprovacao(osId);
    const orcamentos = fila('os_orcamento_disponivel');
    expect(orcamentos).toHaveLength(2);
    expect(orcamentos[1].body_text).toContain('R$ 220,00');
  });

  it('a fila quebrada NÃO desfaz o pedido de aprovação', async () => {
    const osId = await osAssumida(await cliente('quebrada@exemplo.com'));
    await maoDeObra(osId, 15000);
    getConnection().exec(
      `CREATE TRIGGER fila_quebrada BEFORE INSERT ON core_email_queue
       BEGIN SELECT RAISE(ABORT, 'fila indisponível'); END;`,
    );
    try {
      await pedirAprovacao(osId);
    } finally {
      getConnection().exec('DROP TRIGGER fila_quebrada');
    }
    const linha = getConnection()
      .prepare('SELECT approval_requested_at FROM core_service_orders WHERE id = ?')
      .get(osId) as { approval_requested_at: string | null };
    expect(linha.approval_requested_at).toBeTruthy();
    expect(fila()).toHaveLength(0);
  });

  it('OS de OUTRA empresa: a rota de avisos responde 404', async () => {
    const osId = await osAssumida(await cliente('alheio@exemplo.com'));
    const r = await request(app)
      .get(`/api/v1/core/workshop/orders/${osId}/avisos`)
      .set(gerenteOutra);
    expect(r.status).toBe(404);
  });
});

describe('pronta e concluída também avisam', () => {
  it('conclusão com custo: "pronta para retirada", com o valor a pagar; paga no caixa: "finalizada"', async () => {
    const osId = await osAssumida(await cliente('pronta@exemplo.com'));
    await maoDeObra(osId, 15000);
    const fim = await request(app)
      .post(`/api/v1/core/workshop/orders/${osId}/complete`)
      .set(mecanico)
      .send({ diagnosis: 'Troca do controlador', hasCost: true, forcarChecklist: true });
    expect(fim.status, JSON.stringify(fim.body)).toBe(200);

    const [pronta] = fila('os_pronta');
    expect(pronta, 'a OS pronta não avisou').toBeTruthy();
    expect(pronta.subject).toMatch(/OS #\d+ pronta para retirada/);
    expect(pronta.body_text).toContain('Valor a pagar na retirada: R$ 150,00');
    // O diagnóstico é texto da bancada: não vai para o cliente por aqui.
    expect(pronta.body_text).not.toContain('controlador');

    const pago = await request(app)
      .post(`/api/v1/core/workshop/orders/${osId}/checkout`)
      .set(caixa)
      .send({ payments: [{ method: 'dinheiro', amountCents: 15000 }] });
    expect(pago.status, JSON.stringify(pago.body)).toBe(201);

    const [concluida] = fila('os_concluida');
    expect(concluida, 'a OS paga não avisou').toBeTruthy();
    expect(concluida.subject).toMatch(/OS #\d+ finalizada/);
    expect(concluida.body_text).toContain('pagamento de R$ 150,00 registrado');
  });

  it('conclusão sem custo: "concluída", com o motivo', async () => {
    const osId = await osAssumida(await cliente('garantia@exemplo.com'));
    const fim = await request(app)
      .post(`/api/v1/core/workshop/orders/${osId}/complete`)
      .set(mecanico)
      .send({
        diagnosis: 'Ajuste na garantia',
        hasCost: false,
        noCostReason: 'garantia',
        forcarChecklist: true,
      });
    expect(fim.status, JSON.stringify(fim.body)).toBe(200);
    expect(fim.body.status).toBe('finalizada');

    expect(fila('os_pronta')).toHaveLength(0);
    const [concluida] = fila('os_concluida');
    expect(concluida.body_text).toContain('concluído sem custo (garantia)');
  });
});

describe('com credencial, o carteiro entrega', () => {
  it('o orçamento sai pelo SMTP, com o assunto da OS', async () => {
    const osId = await osAssumida(await cliente('entrega@exemplo.com'));
    await maoDeObra(osId, 15000);
    await pedirAprovacao(osId);

    process.env.EMAIL_ENABLED = 'true';
    process.env.EMAIL_FROM = 'grupo@sampaio.com.br';
    process.env.EMAIL_SMTP_HOST = 'smtp.teste.local';
    process.env.EMAIL_SMTP_PORT = '465';
    process.env.EMAIL_SMTP_USER = 'grupo@sampaio.com.br';
    process.env.EMAIL_SMTP_PASSWORD = 'senha-de-teste';
    const enviados: MensagemSmtp[] = [];
    const carteiro: CarteiroSmtp = {
      enviar: (m) => {
        enviados.push(m);
        return Promise.resolve();
      },
    };
    const r = await flushEmailQueue({ carteiro });
    expect(r.sent).toBe(1);
    expect(enviados[0].to).toBe('entrega@exemplo.com');
    expect(enviados[0].subject).toMatch(/orçamento da OS/);
    expect(fila('os_orcamento_disponivel')[0].status).toBe('sent');
  });
});
