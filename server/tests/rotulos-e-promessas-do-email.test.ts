/**
 * ============================================================================
 * O NOME DE CADA MENSAGEM E A PROMESSA DO PORTAL (GAP-PRD-199, GAP-PRD-200)
 * ============================================================================
 *
 * GAP-PRD-199 — a tela da fila tinha rótulo para 4 dos 9 modelos: a
 * recuperação de senha, a conta criada e o pacote do contador apareciam como
 * o código cru. O rótulo mora agora no servidor, tipado pela lista de
 * modelos, e a rota o entrega pronto.
 *
 * GAP-PRD-200 — o portal dizia "enviamos um link para redefinir a senha" (e
 * "código novo enviado") com o carteiro DESLIGADO: o cliente esperava um
 * e-mail que não vinha. A frase agora depende do envio estar ligado — e
 * continua igual para e-mail com conta e sem conta (anti-enumeração).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { resetDbForTests } from '../src/db/database.js';
import { ensureCoreSchema } from '../src/db/schema.js';
import {
  EMAIL_TEMPLATE_LABEL,
  EMAIL_TEMPLATES,
  queuePasswordResetEmail,
  rotuloDoModelo,
} from '../src/services/notifications/EmailService.js';
import { loginForTest } from './helpers/auth.js';

const app = createApp();
const EMPRESA = 'gringa-rot';

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

function semCredencial(): void {
  for (const v of EMAIL_VARS) process.env[v] = '';
  process.env.EMAIL_ENABLED = 'false';
}

function comCredencial(): void {
  process.env.EMAIL_ENABLED = 'true';
  process.env.EMAIL_FROM = 'grupo@sampaio.com.br';
  process.env.EMAIL_SMTP_HOST = 'smtp.teste.local';
  process.env.EMAIL_SMTP_PORT = '465';
  process.env.EMAIL_SMTP_USER = 'grupo@sampaio.com.br';
  process.env.EMAIL_SMTP_PASSWORD = 'senha-de-teste-rot';
}

beforeEach(() => {
  resetDbForTests();
  ensureCoreSchema();
  semCredencial();
});

afterEach(() => {
  for (const v of EMAIL_VARS) {
    const o = originais.get(v);
    if (o === undefined) delete process.env[v];
    else process.env[v] = o;
  }
});

describe('GAP-PRD-199 — todo modelo tem nome em português', () => {
  it('cada modelo da lista tem rótulo, e nenhum rótulo é o código cru', () => {
    for (const t of EMAIL_TEMPLATES) {
      const rotulo = EMAIL_TEMPLATE_LABEL[t];
      expect(rotulo, t).toBeTruthy();
      expect(rotulo).not.toBe(t);
      expect(rotulo).not.toMatch(/_/);
    }
    // Modelo desconhecido (linha antiga de um modelo que deixou de existir)
    // volta como veio — inventar nome esconderia o que ninguém mapeou.
    expect(rotuloDoModelo('modelo_que_nao_existe')).toBe('modelo_que_nao_existe');
  });

  it('a rota da fila entrega o rótulo — a recuperação de senha não aparece como slug', async () => {
    const login = await loginForTest(app, {
      userId: 'ger-rot',
      companyId: EMPRESA,
      profileCodes: ['gerente_loja'],
    });
    queuePasswordResetEmail({
      companyId: EMPRESA,
      toAddress: 'cliente@exemplo.com',
      resetLink: 'https://loja.exemplo/redefinir-senha?token=abc',
      dedupeKey: 'rot-reset-1',
    });
    const r = await request(app)
      .get('/api/v1/core/emails')
      .set({ Authorization: `Bearer ${login.body.accessToken as string}` });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.items[0].template).toBe('recuperacao_senha');
    expect(r.body.items[0].templateLabel).toBe('Recuperação de senha');
  });
});

describe('GAP-PRD-200 — o portal só promete o e-mail que vai chegar', () => {
  async function contaDoPortal(email: string): Promise<string> {
    const r = await request(app)
      .post('/api/v1/loja/portal/registrar')
      .send({ termsAccepted: true, email, password: 'Portal@2026' });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    return r.body.token as string;
  }

  it('com o envio DESLIGADO, "Esqueci minha senha" não diz que enviou — e responde igual com ou sem conta', async () => {
    await contaDoPortal('tem-conta@exemplo.com');
    const comConta = await request(app)
      .post('/api/v1/loja/portal/recuperar-senha')
      .send({ email: 'tem-conta@exemplo.com' });
    const semConta = await request(app)
      .post('/api/v1/loja/portal/recuperar-senha')
      .send({ email: 'ninguem@exemplo.com' });

    expect(comConta.status).toBe(200);
    expect(comConta.body.envioDeEmailAtivo).toBe(false);
    expect(comConta.body.message).toContain('ainda está sendo ativado');
    expect(comConta.body.message).not.toMatch(/enviamos/i);
    // Anti-enumeração: a resposta é a MESMA.
    expect(semConta.body).toEqual(comConta.body);
  });

  it('com o envio LIGADO, a frase de sempre — e ainda igual com ou sem conta', async () => {
    await contaDoPortal('tem-conta2@exemplo.com');
    comCredencial();
    const comConta = await request(app)
      .post('/api/v1/loja/portal/recuperar-senha')
      .send({ email: 'tem-conta2@exemplo.com' });
    const semConta = await request(app)
      .post('/api/v1/loja/portal/recuperar-senha')
      .send({ email: 'ninguem2@exemplo.com' });
    expect(comConta.body.envioDeEmailAtivo).toBe(true);
    expect(comConta.body.message).toContain('enviamos um link');
    expect(semConta.body).toEqual(comConta.body);
  });

  it('"Enviar código" com o envio desligado aponta o caminho do balcão; ligado, "código novo enviado"', async () => {
    const token = await contaDoPortal('codigo@exemplo.com');
    const desligado = await request(app)
      .post('/api/v1/loja/portal/reenviar-verificacao')
      .set({ 'x-portal-token': token });
    expect(desligado.status, JSON.stringify(desligado.body)).toBe(200);
    expect(desligado.body.envioDeEmailAtivo).toBe(false);
    expect(desligado.body.message).toContain('código de convite');
    expect(desligado.body.message).not.toMatch(/enviado/i);

    comCredencial();
    const ligado = await request(app)
      .post('/api/v1/loja/portal/reenviar-verificacao')
      .set({ 'x-portal-token': token });
    expect(ligado.body.envioDeEmailAtivo).toBe(true);
    expect(ligado.body.message).toContain('Código novo enviado');
  });

  it('a tela de acesso pergunta antes: pública, sem conta, sem detalhe de configuração', async () => {
    const desligado = await request(app).get('/api/v1/loja/portal/envio-de-email');
    expect(desligado.status).toBe(200);
    expect(desligado.body.envioDeEmailAtivo).toBe(false);
    expect(desligado.body.message).toContain('ainda está sendo ativado');
    // O que falta configurar é assunto da tela de gestão, não do portal.
    expect(JSON.stringify(desligado.body)).not.toMatch(/EMAIL_|SMTP/);

    comCredencial();
    const ligado = await request(app).get('/api/v1/loja/portal/envio-de-email');
    expect(ligado.body).toEqual({ envioDeEmailAtivo: true, message: null });
  });
});
