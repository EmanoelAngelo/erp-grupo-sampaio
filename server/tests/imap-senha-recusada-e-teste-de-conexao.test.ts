/**
 * ============================================================================
 * A CAIXA DIZ QUE A SENHA FOI RECUSADA, E O DONO TESTA A NOVA NA HORA
 * (GAP-PRD-128)
 * ============================================================================
 *
 * O QUE ERA:
 *   A caixa da Preço Justo (imap.gmail.com) falha com "Command failed" desde
 *   13/08. A tela dizia "CONFIGURADA / CONFIGURED" com o erro em letra
 *   vermelha embaixo — e o único jeito de saber se uma senha nova funcionava
 *   era clicar em "Ler agora" (que já processa notas) ou ligar a leitura
 *   automática e esperar o erro voltar.
 *
 * O QUE ESTE ARQUIVO TRAVA:
 *   - a falha é classificada: senha recusada (CREDENTIAL_REJECTED, com o
 *     passo a passo da senha de aplicativo), pasta que não existe, provedor
 *     fora (CONNECTION_FAILING);
 *   - senha nova apaga o erro da senha antiga;
 *   - "Testar conexão" entra, abre a pasta e sai: diz quantas mensagens há e
 *     não processa, não marca, não move nada; é do gestor, da empresa do
 *     token, auditado, e a senha nunca aparece na resposta;
 *   - o que falta depois disso é só a senha — insumo do dono.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';

process.env.DEVORA_API_ENV = 'test';
process.env.DEVORA_JWT_SECRET = 'test-jwt-secret-suficientemente-longo';
process.env.DEVORA_ENCRYPTION_KEY = 'test-encryption-key-suficientemente-longa';

vi.mock('imapflow', async () => (await import('./helpers/imapFalso.js')).moduloImapFalso);

const imap = await import('./helpers/imapFalso.js');
const { createApp } = await import('../src/app.js');
const { resetDbForTests } = await import('../src/db/database.js');
const { getConnection } = await import('../src/db/sqlite.js');
const { loginForTest } = await import('./helpers/auth.js');
const { listAudit } = await import('../src/services/audit/AuditService.js');
const { checkInbox, getInboxStatus, testarConexao, upsertInbox } = await import(
  '../src/services/core/MailInboxService.js'
);

const app = createApp();
const EMPRESA = 'preco-justo-128';
const OUTRA = 'gringa-128';
const SENHA_VELHA = 'senha-normal-da-conta-128';
const SENHA_NOVA = 'abcd efgh ijkl mnop';

let gerente: { Authorization: string };
let estoquista: { Authorization: string };
let gerenteOutra: { Authorization: string };

async function token(userId: string, companyId: string, perfil: string) {
  const r = await loginForTest(app, { userId, companyId, profileCodes: [perfil] });
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return { Authorization: `Bearer ${r.body.accessToken as string}` };
}

function caixaDaPrecoJusto(senha = SENHA_VELHA) {
  return upsertInbox({
    companyId: EMPRESA,
    address: 'precojusto@gmail.com',
    host: 'imap.gmail.com',
    port: 993,
    password: senha,
  });
}

beforeEach(async () => {
  resetDbForTests();
  imap.reiniciarImap();
  gerente = await token('ger-128', EMPRESA, 'gerente_loja');
  estoquista = await token('est-128', EMPRESA, 'estoquista');
  gerenteOutra = await token('ger-outra-128', OUTRA, 'gerente_loja');
});

describe('a senha recusada é dita pelo nome', () => {
  it('"Command failed" no login vira CREDENTIAL_REJECTED, com o passo a passo da senha de aplicativo', async () => {
    caixaDaPrecoJusto();
    imap.estadoImap.falhaNoLogin = '[AUTHENTICATIONFAILED] Invalid credentials (Failure)';

    await expect(checkInbox({ companyId: EMPRESA, userId: 'ger-128' })).rejects.toMatchObject({
      code: 'CORE_MAIL_CONNECTION_FAILED',
    });

    const s = getInboxStatus(EMPRESA);
    expect(s.readiness).toBe('CREDENTIAL_REJECTED');
    expect(s.message).toMatch(/recusou a senha/);
    expect(s.message).toMatch(/Senhas de app/);
    expect(s.message).toMatch(/IMAP/);
    expect(s.inbox?.last_error_kind).toBe('credencial');
    expect(s.inbox?.last_error).toMatch(/Invalid credentials/);
    // A senha nunca vai para a mensagem guardada.
    expect(JSON.stringify(s)).not.toContain(SENHA_VELHA);
  });

  it('a caixa como está no banco (erro "Command failed" de 13/08, coluna do tipo vazia) já aparece como senha recusada', () => {
    caixaDaPrecoJusto();
    getConnection()
      .prepare(
        `UPDATE core_mail_inboxes
            SET last_error = 'Command failed', last_error_kind = NULL,
                last_check_at = '2026-08-13T15:14:46.628Z', auto_enabled = 0
          WHERE company_id = ?`,
      )
      .run(EMPRESA);

    const s = getInboxStatus(EMPRESA);
    expect(s.readiness).toBe('CREDENTIAL_REJECTED');
    expect(s.inbox?.last_error_kind).toBe('credencial');
    expect(s.message).toMatch(/Senhas de app/);
  });

  it('só "Command failed", sem outro sinal, também é tratado como senha (é o que o Gmail devolve)', async () => {
    caixaDaPrecoJusto();
    const { estadoImap } = imap;
    estadoImap.falhaDeRede = null;
    // Sem `authenticationFailed` e sem texto do servidor.
    const original = imap.moduloImapFalso.ImapFlow.prototype.connect;
    imap.moduloImapFalso.ImapFlow.prototype.connect = async () => {
      throw new Error('Command failed');
    };
    try {
      await expect(checkInbox({ companyId: EMPRESA, userId: 'ger-128' })).rejects.toBeTruthy();
    } finally {
      imap.moduloImapFalso.ImapFlow.prototype.connect = original;
    }
    expect(getInboxStatus(EMPRESA).readiness).toBe('CREDENTIAL_REJECTED');
  });

  it('pasta que não existe e provedor fora do ar são CONNECTION_FAILING, cada um com seu motivo', async () => {
    upsertInbox({
      companyId: EMPRESA,
      address: 'precojusto@gmail.com',
      host: 'imap.gmail.com',
      password: SENHA_VELHA,
      folder: 'Notas',
    });
    await expect(checkInbox({ companyId: EMPRESA, userId: 'ger-128' })).rejects.toBeTruthy();
    let s = getInboxStatus(EMPRESA);
    expect(s.readiness).toBe('CONNECTION_FAILING');
    expect(s.inbox?.last_error_kind).toBe('pasta');
    expect(s.message).toMatch(/pasta "Notas" não foi encontrada/);

    upsertInbox({ companyId: EMPRESA, address: 'precojusto@gmail.com', host: 'imap.gmail.com', folder: 'INBOX' });
    imap.estadoImap.falhaDeRede = 'connect ECONNREFUSED 10.0.0.1:993';
    await expect(checkInbox({ companyId: EMPRESA, userId: 'ger-128' })).rejects.toBeTruthy();
    s = getInboxStatus(EMPRESA);
    expect(s.readiness).toBe('CONNECTION_FAILING');
    expect(s.inbox?.last_error_kind).toBe('conexao');
    expect(s.inbox?.last_error).toMatch(/ECONNREFUSED.*imap\.gmail\.com.*993/);
  });

  it('senha nova apaga o erro da senha antiga — e a leitura seguinte, com ela aceita, volta a CONFIGURED', async () => {
    caixaDaPrecoJusto();
    imap.estadoImap.falhaNoLogin = '[AUTHENTICATIONFAILED] Invalid credentials (Failure)';
    await expect(checkInbox({ companyId: EMPRESA, userId: 'ger-128' })).rejects.toBeTruthy();
    expect(getInboxStatus(EMPRESA).readiness).toBe('CREDENTIAL_REJECTED');

    // Salvar o formulário SEM senha não apaga o erro: a senha continua a mesma.
    upsertInbox({ companyId: EMPRESA, address: 'precojusto@gmail.com', host: 'imap.gmail.com' });
    expect(getInboxStatus(EMPRESA).readiness).toBe('CREDENTIAL_REJECTED');

    caixaDaPrecoJusto(SENHA_NOVA);
    const s = getInboxStatus(EMPRESA);
    expect(s.readiness).toBe('CONFIGURED');
    expect(s.inbox?.last_error).toBeNull();

    imap.estadoImap.falhaNoLogin = null;
    const leitura = await checkInbox({ companyId: EMPRESA, userId: 'ger-128' });
    expect(leitura.checked).toBe(0);
    expect(getInboxStatus(EMPRESA).inbox?.last_ok_at).toBeTruthy();
  });
});

describe('"Testar conexão"', () => {
  it('com a senha aceita: diz quantas mensagens há, e não lê, não marca, não move nada', async () => {
    caixaDaPrecoJusto(SENHA_NOVA);
    imap.entregar(imap.emailCru({ assunto: 'NF-e 1', anexo: { nome: 'n.xml', conteudo: '<x/>' } }));
    imap.entregar(imap.emailCru({ assunto: 'Oferta' }), { lida: true });

    const r = await request(app).post('/api/v1/core/mail/inbox/test').set(gerente);

    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.ok).toBe(true);
    expect(r.body.mensagens).toBe(2);
    expect(r.body.naoLidas).toBe(1);
    expect(r.body.message).toMatch(/Conexão aceita.*Nenhuma foi lida agora/);
    expect(r.body.status.readiness).toBe('CONFIGURED');
    expect(imap.estadoImap.downloads).toEqual([]);
    expect(imap.estadoImap.comandos.some((c) => /^(STORE|MOVE|FETCH)/.test(c))).toBe(false);
    expect(imap.lida(1)).toBe(false);
    expect(
      (getConnection().prepare('SELECT COUNT(*) n FROM core_mail_messages').get() as { n: number }).n,
    ).toBe(0);
    // O log do imapflow fica desligado: ele despeja a conversa, senha incluída.
    expect(imap.estadoImap.ultimaConfig?.logger).toBe(false);
    expect(JSON.stringify(r.body)).not.toContain(SENHA_NOVA);

    const acoes = (listAudit(EMPRESA, { limit: 20 }).items as unknown as { action: string; detail?: unknown }[]).map(
      (a) => a.action,
    );
    expect(acoes).toContain('mail.inbox.test');
  });

  it('com a senha recusada: 200 com ok=false, o motivo e a situação CREDENTIAL_REJECTED', async () => {
    caixaDaPrecoJusto();
    imap.estadoImap.falhaNoLogin = '[ALERT] Application-specific password required';

    const r = await request(app).post('/api/v1/core/mail/inbox/test').set(gerente);

    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(false);
    expect(r.body.tipo).toBe('credencial');
    expect(r.body.message).toMatch(/Application-specific password required/);
    expect(r.body.status.readiness).toBe('CREDENTIAL_REJECTED');
    expect(JSON.stringify(r.body)).not.toContain(SENHA_VELHA);
  });

  it('sem caixa ou sem senha: 409 dizendo o que falta', async () => {
    const r = await request(app).post('/api/v1/core/mail/inbox/test').set(gerente);
    expect(r.status).toBe(409);
    expect(JSON.stringify(r.body)).toMatch(/senha de aplicativo/);
  });

  it('é do gestor: o estoquista lê a caixa, mas não testa nem configura', async () => {
    caixaDaPrecoJusto(SENHA_NOVA);
    const r = await request(app).post('/api/v1/core/mail/inbox/test').set(estoquista);
    expect(r.status).toBe(403);
  });

  it('testa só a caixa da empresa do token', async () => {
    caixaDaPrecoJusto(SENHA_NOVA);
    const r = await request(app).post('/api/v1/core/mail/inbox/test').set(gerenteOutra);
    // A outra empresa não tem caixa: não enxerga a da Preço Justo.
    expect(r.status).toBe(409);
    expect(imap.estadoImap.conexoes).toBe(0);
  });

  it('o teste pelo serviço é o mesmo da rota', async () => {
    caixaDaPrecoJusto(SENHA_NOVA);
    const t = await testarConexao(EMPRESA);
    expect(t.ok).toBe(true);
    expect(t.status.inbox?.last_ok_at).toBeTruthy();
  });
});
