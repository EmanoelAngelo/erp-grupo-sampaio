/**
 * ============================================================================
 * CADA EMPRESA NA SUA FILA, E COM A IDENTIDADE QUE O DONO ESCOLHER (GAP-PRD-198)
 * ============================================================================
 *
 * O QUE ERA:
 *   - `POST /core/emails/enviar` do gerente da empresa A chamava o flush SEM
 *     empresa: a mensagem da empresa B virava `sent` por um gesto de A
 *     (escrita de estado cruzando a fronteira; o harness da auditoria viu
 *     `sendMail` para os dois endereços);
 *   - um só `EMAIL_FROM` para as seis: o cliente da Gringa recebia de
 *     "grupo@…", sem Reply-To da loja.
 *
 * O QUE ESTE ARQUIVO TRAVA:
 *   - o clique do gerente entrega SÓ a fila da empresa dele; o worker de
 *     fundo (sem empresa) segue entregando a das seis;
 *   - sem escolha nenhuma, nada muda (modo `grupo`, o padrão seguro);
 *   - no modo `empresa`: nome no "De:", Reply-To da loja, assinatura no fim
 *     da mensagem, endereço próprio opcional — só para aquela empresa;
 *   - a escolha é da empresa do TOKEN, auditada, validada (sem cabeçalho
 *     injetado), e o caixa não mexe.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { resetDbForTests } from '../src/db/database.js';
import { getConnection } from '../src/db/sqlite.js';
import { flushEmailQueue, queueEmail } from '../src/services/notifications/EmailService.js';
import { loginForTest } from './helpers/auth.js';

const { sendMail } = vi.hoisted(() => ({ sendMail: vi.fn() }));
vi.mock('nodemailer', () => ({
  default: { createTransport: () => ({ sendMail }) },
}));

const app = createApp();
const A = 'preco-justo-rpe';
const B = 'gringa-rpe';

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

function comCredencial(): void {
  process.env.EMAIL_ENABLED = 'true';
  process.env.EMAIL_FROM = 'Grupo Sampaio <grupo@sampaio.com.br>';
  process.env.EMAIL_SMTP_HOST = 'smtp.teste.local';
  process.env.EMAIL_SMTP_PORT = '465';
  process.env.EMAIL_SMTP_USER = 'grupo@sampaio.com.br';
  process.env.EMAIL_SMTP_PASSWORD = 'senha-de-teste-rpe';
}

let gerenteA: { Authorization: string };
let gerenteB: { Authorization: string };
let caixaB: { Authorization: string };
let n = 0;

async function token(userId: string, companyId: string, perfil: string) {
  const r = await loginForTest(app, { userId, companyId, profileCodes: [perfil] });
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return { Authorization: `Bearer ${r.body.accessToken as string}` };
}

beforeEach(async () => {
  resetDbForTests();
  n = 0;
  sendMail.mockReset();
  sendMail.mockResolvedValue({});
  comCredencial();
  gerenteA = await token('ger-a-rpe', A, 'gerente_loja');
  gerenteB = await token('ger-b-rpe', B, 'gerente_loja');
  caixaB = await token('cx-b-rpe', B, 'operador_caixa_loja');
  getConnection().prepare('UPDATE core_companies SET trade_name = ? WHERE id = ?').run('Preço Justo', A);
  getConnection().prepare('UPDATE core_companies SET trade_name = ? WHERE id = ?').run('Gringa', B);
});

afterEach(() => {
  for (const v of EMAIL_VARS) {
    const o = originais.get(v);
    if (o === undefined) delete process.env[v];
    else process.env[v] = o;
  }
});

function enfileirar(companyId: string, para: string, loja: string): string {
  n += 1;
  const id = queueEmail({
    companyId,
    template: 'pagamento_confirmado',
    toAddress: para,
    dedupeKey: `rpe-${n}`,
    context: { storeName: loja, customerName: 'Ana', orderNumber: n, totalCents: 1000 },
  });
  expect(id).toBeTruthy();
  return id!;
}

function situacao(id: string): string {
  return (
    getConnection().prepare('SELECT status FROM core_email_queue WHERE id = ?').get(id) as {
      status: string;
    }
  ).status;
}

function corpo(id: string): string {
  return (
    getConnection().prepare('SELECT body_text FROM core_email_queue WHERE id = ?').get(id) as {
      body_text: string;
    }
  ).body_text;
}

describe('o clique do gerente entrega só a fila da empresa dele', () => {
  it('o gerente de A processa a fila: a mensagem de B continua pendente', async () => {
    const deA = enfileirar(A, 'a@exemplo.com', 'Preço Justo');
    const deB = enfileirar(B, 'b@exemplo.com', 'Gringa');

    const r = await request(app).post('/api/v1/core/emails/enviar').set(gerenteA);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.sent).toBe(1);

    expect(sendMail).toHaveBeenCalledTimes(1);
    expect(sendMail.mock.calls[0][0].to).toBe('a@exemplo.com');
    expect(situacao(deA)).toBe('sent');
    expect(situacao(deB)).toBe('pending');

    // O worker de fundo continua sendo o carteiro das seis.
    const fundo = await flushEmailQueue();
    expect(fundo.sent).toBe(1);
    expect(situacao(deB)).toBe('sent');
  });

  it('clique de A e worker ao mesmo tempo: cada mensagem sai UMA vez', async () => {
    enfileirar(A, 'a1@exemplo.com', 'Preço Justo');
    enfileirar(B, 'b1@exemplo.com', 'Gringa');
    const [clique, fundo] = await Promise.all([
      flushEmailQueue({ companyId: A }),
      flushEmailQueue(),
    ]);
    expect(clique.sent + fundo.sent).toBe(2);
    const destinos = sendMail.mock.calls.map((c) => (c[0] as { to: string }).to).sort();
    expect(destinos).toEqual(['a1@exemplo.com', 'b1@exemplo.com']);
  });
});

describe('a identidade do remetente — decisão do dono, com padrão seguro', () => {
  it('sem escolha, nada muda: remetente do ambiente, sem Reply-To, assinatura do grupo', async () => {
    const g = await request(app).get('/api/v1/core/emails/identidade').set(gerenteB);
    expect(g.status, JSON.stringify(g.body)).toBe(200);
    expect(g.body.identidade.modo).toBe('grupo');
    expect(g.body.previa.de).toBe('Grupo Sampaio <grupo@sampaio.com.br>');
    expect(g.body.previa.responderPara).toBeNull();
    expect(g.body.previa.assinatura).toBe('Gringa — Grupo Sampaio');

    const id = enfileirar(B, 'b@exemplo.com', 'Gringa');
    expect(corpo(id)).toMatch(/Gringa — Grupo Sampaio$/);
    await flushEmailQueue();
    const msg = sendMail.mock.calls[0][0] as Record<string, unknown>;
    expect(msg.from).toBe('Grupo Sampaio <grupo@sampaio.com.br>');
    expect(msg).not.toHaveProperty('replyTo');
  });

  it('modo empresa: "De: Gringa", Reply-To da loja e assinatura própria — só na Gringa, e auditado', async () => {
    const r = await request(app)
      .put('/api/v1/core/emails/identidade')
      .set(gerenteB)
      // O companyId do corpo é ignorado: vale o do token.
      .send({
        companyId: A,
        modo: 'empresa',
        nomeRemetente: 'Gringa',
        responderPara: 'Contato@Gringa.com.br',
        assinatura: 'Gringa Moda — atendimento de seg. a sáb.',
      });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.identidade).toMatchObject({
      modo: 'empresa',
      nomeRemetente: 'Gringa',
      responderPara: 'contato@gringa.com.br',
    });
    expect(r.body.previa.de).toBe('"Gringa" <grupo@sampaio.com.br>');
    expect(r.body.previa.responderPara).toBe('contato@gringa.com.br');

    const auditoria = getConnection()
      .prepare(
        `SELECT company_id FROM core_audit_log WHERE action = 'email.identidade.update'`,
      )
      .all() as { company_id: string }[];
    expect(auditoria.map((a) => a.company_id)).toEqual([B]);

    const deB = enfileirar(B, 'b@exemplo.com', 'Gringa');
    const deA = enfileirar(A, 'a@exemplo.com', 'Preço Justo');
    expect(corpo(deB)).toMatch(/Gringa Moda — atendimento de seg\. a sáb\.$/);
    expect(corpo(deA)).toMatch(/Preço Justo — Grupo Sampaio$/);

    await flushEmailQueue();
    const porDestino = new Map(
      sendMail.mock.calls.map((c) => [(c[0] as { to: string }).to, c[0] as Record<string, unknown>]),
    );
    expect(porDestino.get('b@exemplo.com')).toMatchObject({
      from: '"Gringa" <grupo@sampaio.com.br>',
      replyTo: 'contato@gringa.com.br',
    });
    expect(porDestino.get('a@exemplo.com')?.from).toBe('Grupo Sampaio <grupo@sampaio.com.br>');
    expect(porDestino.get('a@exemplo.com')).not.toHaveProperty('replyTo');
  });

  it('endereço próprio: sai por ele, e a prévia avisa que o provedor precisa permitir', async () => {
    const r = await request(app)
      .put('/api/v1/core/emails/identidade')
      .set(gerenteB)
      .send({ modo: 'empresa', nomeRemetente: 'Gringa', enderecoRemetente: 'loja@gringa.com.br' });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.previa.de).toBe('"Gringa" <loja@gringa.com.br>');
    expect(r.body.previa.aviso).toMatch(/provedor/);

    enfileirar(B, 'b@exemplo.com', 'Gringa');
    await flushEmailQueue();
    expect((sendMail.mock.calls[0][0] as { from: string }).from).toBe('"Gringa" <loja@gringa.com.br>');
  });

  it('voltar ao modo grupo desliga tudo, mas guarda o que foi digitado', async () => {
    await request(app)
      .put('/api/v1/core/emails/identidade')
      .set(gerenteB)
      .send({ modo: 'empresa', nomeRemetente: 'Gringa', responderPara: 'contato@gringa.com.br' })
      .expect(200);
    const volta = await request(app)
      .put('/api/v1/core/emails/identidade')
      .set(gerenteB)
      .send({ modo: 'grupo', nomeRemetente: 'Gringa', responderPara: 'contato@gringa.com.br' });
    expect(volta.status).toBe(200);
    expect(volta.body.identidade.nomeRemetente).toBe('Gringa');
    expect(volta.body.previa.de).toBe('Grupo Sampaio <grupo@sampaio.com.br>');
    expect(volta.body.previa.responderPara).toBeNull();

    enfileirar(B, 'b@exemplo.com', 'Gringa');
    await flushEmailQueue();
    expect(sendMail.mock.calls[0][0]).not.toHaveProperty('replyTo');
  });

  it('recusa cabeçalho injetado, endereço torto e modo empresa sem nome — e o caixa não mexe', async () => {
    const put = (corpoDoPedido: Record<string, unknown>, quem = gerenteB) =>
      request(app).put('/api/v1/core/emails/identidade').set(quem).send(corpoDoPedido);

    const injetado = await put({ modo: 'empresa', nomeRemetente: 'Gringa\r\nBcc: ladrao@x.com' });
    expect(injetado.status).toBe(400);
    expect(injetado.body.error.code).toBe('EMAIL_IDENTIDADE_INVALIDA');
    expect((await put({ modo: 'empresa', nomeRemetente: 'Gringa <x@y.com>' })).status).toBe(400);
    expect((await put({ modo: 'empresa', nomeRemetente: 'Gringa', responderPara: 'sem-arroba' })).status).toBe(400);
    expect((await put({ modo: 'empresa' })).status).toBe(400);
    expect((await put({ modo: 'outro' })).status).toBe(400);
    expect((await put({ modo: 'grupo' }, caixaB)).status).toBe(403);

    // Nada foi gravado por nenhuma das recusas.
    const g = await request(app).get('/api/v1/core/emails/identidade').set(gerenteB);
    expect(g.body.identidade.modo).toBe('grupo');
    expect(g.body.identidade.updatedAt).toBeNull();
  });
});
