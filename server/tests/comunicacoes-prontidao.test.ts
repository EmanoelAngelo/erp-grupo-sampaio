/**
 * ============================================================================
 * UM LUGAR QUE DIZ O QUE FALTA PARA AS COMUNICAÇÕES SAÍREM (GAP-PRD-130)
 * ============================================================================
 *
 * O QUE ERA:
 *   E-mail ao cliente, pacote do contador e NF-e por e-mail estavam
 *   programados — mas nada saía, e ninguém via o porquê num lugar só: o SMTP
 *   no .env, a fila acumulando desde 16/08, nenhuma das seis empresas com
 *   destinatário do contador, agenda ou usuário contador. Descobrir exigia
 *   três telas e uma consulta ao banco.
 *
 * O QUE ESTE ARQUIVO TRAVA:
 *   - GET /core/comunicacoes/prontidao lista, para a empresa do TOKEN, cada
 *     peça com a situação (ok / falta / opcional), o que fazer, quem fornece
 *     e onde;
 *   - com tudo configurado — o SMTP no ambiente (relido sem reinício),
 *     destinatário, agenda, usuário contador, caixa com leitura automática —
 *     a lista fica verde SEM uma linha de código: é o critério de
 *     configuração externa;
 *   - uma empresa não vê a configuração da outra; contador e caixa não
 *     acessam (mesmo alcance da fila de e-mail).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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
const { linkUserToCompany, upsertUser } = await import('../src/services/auth/IdentityService.js');
const { queueEmail } = await import('../src/services/notifications/EmailService.js');
const { criarDestinatario, gravarAgendaDoContador } = await import(
  '../src/services/core/ContadorEnvioService.js'
);
const { upsertInbox, testarConexao } = await import('../src/services/core/MailInboxService.js');
const { setSchedule } = await import('../src/services/core/MailInboxScheduler.js');
const { prontidaoDasComunicacoes } = await import(
  '../src/services/notifications/ProntidaoDasComunicacoes.js'
);

const app = createApp();
const GRINGA = 'gringa-130';
const PRECO = 'preco-justo-130';

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

function semSmtp(): void {
  for (const v of EMAIL_VARS) delete process.env[v];
}

function comSmtp(): void {
  process.env.EMAIL_ENABLED = 'true';
  process.env.EMAIL_FROM = 'Grupo Sampaio <grupo@sampaio.com.br>';
  process.env.EMAIL_SMTP_HOST = 'smtp.teste.local';
  process.env.EMAIL_SMTP_PORT = '465';
  process.env.EMAIL_SMTP_USER = 'grupo@sampaio.com.br';
  process.env.EMAIL_SMTP_PASSWORD = 'senha-de-teste-130';
}

let gerenteGringa: { Authorization: string };
let gerentePreco: { Authorization: string };
let caixaGringa: { Authorization: string };
let contadorGringa: { Authorization: string };

async function token(userId: string, companyId: string, perfil: string) {
  const r = await loginForTest(app, { userId, companyId, profileCodes: [perfil] });
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return { Authorization: `Bearer ${r.body.accessToken as string}` };
}

function item(p: { itens: { chave: string }[] }, chave: string) {
  const achado = p.itens.find((i) => i.chave === chave);
  expect(achado, `item ${chave}`).toBeTruthy();
  return achado as unknown as {
    chave: string;
    situacao: string;
    detalhe: string;
    oQueFazer: string | null;
    quem: string | null;
    onde: { rotulo: string; caminho: string | null } | null;
  };
}

beforeEach(async () => {
  resetDbForTests();
  imap.reiniciarImap();
  semSmtp();
  gerenteGringa = await token('ger-gringa-130', GRINGA, 'gerente_loja');
  gerentePreco = await token('ger-preco-130', PRECO, 'gerente_loja');
  caixaGringa = await token('cx-gringa-130', GRINGA, 'operador_caixa_loja');
});

afterEach(() => {
  for (const v of EMAIL_VARS) {
    const o = originais.get(v);
    if (o === undefined) delete process.env[v];
    else process.env[v] = o;
  }
});

describe('a empresa como a auditoria encontrou: tudo programado, nada configurado', () => {
  it('a lista diz cada peça que falta, o que fazer e quem fornece', async () => {
    // O pagamento confirmado da Gringa parado na fila desde 16/08.
    queueEmail({
      companyId: GRINGA,
      template: 'pagamento_confirmado',
      toAddress: 'cliente@exemplo.com',
      dedupeKey: 'gringa-130-1',
      context: { storeName: 'Gringa', customerName: 'Ana', orderNumber: 7, totalCents: 1000 },
    });
    getConnection()
      .prepare("UPDATE core_email_queue SET created_at = '2026-08-16T15:00:00.000Z' WHERE company_id = ?")
      .run(GRINGA);

    const r = await request(app).get('/api/v1/core/comunicacoes/prontidao').set(gerenteGringa);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.companyId).toBe(GRINGA);
    expect(r.body.pronto).toBe(false);

    const carteiro = item(r.body, 'carteiro');
    expect(carteiro.situacao).toBe('falta');
    expect(carteiro.detalhe).toMatch(/EMAIL_ENABLED=true/);
    expect(carteiro.detalhe).toMatch(/1 mensagem\(ns\) desta empresa esperam na fila \(a mais antiga desde 16\/08\/2026\)/);
    expect(carteiro.oQueFazer).toMatch(/não precisa reiniciar/);
    expect(carteiro.quem).toBe('dono');
    expect(carteiro.onde).toEqual({ rotulo: '.env do servidor', caminho: null });

    const destinatario = item(r.body, 'contador_destinatario');
    expect(destinatario.situacao).toBe('falta');
    expect(destinatario.onde?.caminho).toBe('/sistema/fiscal/fechamento');

    const agenda = item(r.body, 'contador_agenda');
    expect(agenda.situacao).toBe('falta');

    const usuario = item(r.body, 'contador_usuario');
    expect(usuario.situacao).toBe('falta');
    expect(usuario.oQueFazer).toMatch(/Escritório de contabilidade \(externo\)/);
    expect(usuario.onde?.caminho).toBe('/sistema/usuarios');

    // Remetente: o padrão já funciona — é escolha, não pendência.
    expect(item(r.body, 'remetente').situacao).toBe('ok');
    // Caixa de NF-e: sem caixa, é opcional (as notas entram pelo upload).
    expect(item(r.body, 'caixa_nfe').situacao).toBe('opcional');

    expect(r.body.faltam).toBe(4);
  });

  it('a caixa com a senha recusada aparece como falta, com o passo seguinte', async () => {
    upsertInbox({ companyId: PRECO, address: 'precojusto@gmail.com', host: 'imap.gmail.com', password: 'velha' });
    imap.estadoImap.falhaNoLogin = '[AUTHENTICATIONFAILED] Invalid credentials (Failure)';
    await testarConexao(PRECO);

    const r = await request(app).get('/api/v1/core/comunicacoes/prontidao').set(gerentePreco);
    const caixa = item(r.body, 'caixa_nfe');
    expect(caixa.situacao).toBe('falta');
    expect(caixa.detalhe).toMatch(/precojusto@gmail.com.*Invalid credentials/);
    expect(caixa.oQueFazer).toMatch(/senha de aplicativo/);
    expect(caixa.quem).toBe('dono');
    expect(caixa.onde?.caminho).toBe('/sistema/compras/nfe-email');
  });
});

describe('com os insumos em mãos, nenhuma linha de código', () => {
  it('SMTP no ambiente, destinatário, agenda, usuário contador e caixa ligada: tudo verde', async () => {
    comSmtp(); // relido ao vivo — sem reiniciar (GAP-PRD-065)
    criarDestinatario({ companyId: GRINGA, name: 'Escritório Contábil', email: 'fiscal@contabil.com.br' });
    gravarAgendaDoContador({ companyId: GRINGA, dayOfMonth: 1, active: true });
    const contadorId = await upsertUser({
      login: 'contador.gringa',
      displayName: 'Escritório Contábil',
      password: 'senha-teste-contador-130',
    });
    linkUserToCompany(contadorId, GRINGA, 'contador', true);
    upsertInbox({ companyId: GRINGA, address: 'notas@gringa.com.br', host: 'imap.gmail.com', password: 'app' });
    setSchedule({ companyId: GRINGA, enabled: true, intervalMinutes: 5 });

    const p = prontidaoDasComunicacoes(GRINGA);
    expect(p.itens.filter((i) => i.situacao !== 'ok')).toEqual([]);
    expect(p.pronto).toBe(true);
    expect(p.faltam).toBe(0);
    expect(item(p, 'contador_agenda').detalhe).toMatch(/Todo dia 1/);
    expect(item(p, 'contador_usuario').detalhe).toMatch(/Escritório Contábil \(ainda não entrou\)/);
    expect(item(p, 'contador_destinatario').detalhe).toMatch(/fiscal@contabil\.com\.br/);
    expect(item(p, 'caixa_nfe').detalhe).toMatch(/a cada 5 min/);
    // A senha do SMTP nunca aparece.
    expect(JSON.stringify(p)).not.toContain('senha-de-teste-130');
  });

  it('a mensagem que desistiu vira pendência do gerente, com o caminho do "Reenviar"', () => {
    comSmtp();
    queueEmail({
      companyId: GRINGA,
      template: 'pagamento_confirmado',
      toAddress: 'cliente@exemplo.com',
      dedupeKey: 'gringa-130-falhou',
      context: { storeName: 'Gringa', customerName: 'Ana', orderNumber: 8, totalCents: 1000 },
    });
    getConnection().prepare("UPDATE core_email_queue SET status = 'failed' WHERE company_id = ?").run(GRINGA);
    const fila = item(prontidaoDasComunicacoes(GRINGA), 'fila');
    expect(fila.situacao).toBe('falta');
    expect(fila.oQueFazer).toMatch(/Reenviar/);
    expect(fila.onde?.caminho).toBe('/sistema/loja/emails');
  });
});

describe('alcance', () => {
  it('a configuração de uma empresa não conta para a outra', async () => {
    criarDestinatario({ companyId: GRINGA, name: 'Escritório', email: 'fiscal@contabil.com.br' });
    const r = await request(app).get('/api/v1/core/comunicacoes/prontidao').set(gerentePreco);
    expect(r.body.companyId).toBe(PRECO);
    expect(item(r.body, 'contador_destinatario').situacao).toBe('falta');
    expect(JSON.stringify(r.body)).not.toContain('fiscal@contabil.com.br');
  });

  it('o caixa e o contador não abrem (mesmo alcance da fila de e-mail)', async () => {
    contadorGringa = await token('contador-130', GRINGA, 'contador');
    const doCaixa = await request(app).get('/api/v1/core/comunicacoes/prontidao').set(caixaGringa);
    expect(doCaixa.status).toBe(403);
    const doContador = await request(app).get('/api/v1/core/comunicacoes/prontidao').set(contadorGringa);
    expect(doContador.status).toBe(403);
  });
});
