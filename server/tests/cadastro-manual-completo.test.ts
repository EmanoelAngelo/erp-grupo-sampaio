/**
 * GAP-PRD-192 — O CADASTRO MANUAL COMPLETO: nome, e-mail de verdade, senha
 * que não é das primeiras que um invasor tenta, e um teto por origem.
 *
 * A auditoria criou conta com '12345678' (201), sem nome
 * (`registerCustomerAccount` não recebia o campo), com "e-mail" que só
 * precisava conter '@', e o único freio era o limite global de 300/min por
 * origem — 18 mil contas por hora do mesmo endereço.
 *
 * `DEVORA_TRUST_PROXY=1` neste arquivo: o teste declara um proxy confiável
 * para mandar ORIGENS diferentes pelo `X-Forwarded-For` — é o mesmo
 * mecanismo que o dono liga em produção atrás do proxy reverso.
 */
process.env.DEVORA_TRUST_PROXY = '1';

import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { resetDbForTests } from '../src/db/database.js';
import { getConnection } from '../src/db/sqlite.js';
import { upsertCompany } from '../src/services/auth/IdentityService.js';
import { confirmarEmail } from '../src/services/core/CustomerPortalService.js';
import { emitirConvitePortal } from '../src/services/core/EquipmentPortalService.js';
import { motivoDeSenhaFraca, emailValido } from '../src/services/core/PoliticaDoCadastro.js';
import { textoDeEntrega } from '../src/services/notifications/EmailService.js';

const app = createApp();
const BASE = '/api/v1/loja/portal';
const SENHA = 'Casa-da-Serra-2026';

function registrar(corpo: Record<string, unknown>, origem = '203.0.113.10') {
  return request(app)
    .post(`${BASE}/registrar`)
    .set('X-Forwarded-For', origem)
    .send({ termsAccepted: true, password: SENHA, ...corpo });
}

function contas(): number {
  return (getConnection().prepare('SELECT COUNT(*) c FROM core_customer_accounts').get() as { c: number }).c;
}

function codigoDaCaixa(email: string): string {
  const linha = getConnection()
    .prepare(
      `SELECT id FROM core_email_queue
        WHERE template = 'verificacao_email' AND to_address = ? ORDER BY created_at DESC LIMIT 1`,
    )
    .get(email) as { id: string };
  return textoDeEntrega(linha.id)!.match(/é: (\d{6})/)![1];
}

beforeEach(() => {
  resetDbForTests();
  upsertCompany({ id: 'gringa', slug: 'gringa', legalName: 'Gringa Ltda', tradeName: 'Gringa' });
});

describe('GAP-PRD-192 — o nome nasce na conta', () => {
  it('o nome digitado no cadastro é guardado na conta e volta no perfil', async () => {
    const res = await registrar({ email: 'ana@exemplo.com', name: '  Ana   Paula  Souza ' });
    expect(res.status, JSON.stringify(res.body)).toBe(201);

    const linha = getConnection()
      .prepare('SELECT name FROM core_customer_accounts WHERE email = ?')
      .get('ana@exemplo.com') as { name: string };
    expect(linha.name).toBe('Ana Paula Souza');

    const perfil = await request(app).get(`${BASE}/perfil`).set('x-portal-token', res.body.token);
    expect(perfil.body.name).toBe('Ana Paula Souza');
    expect(perfil.body.nameSource).toBe('conta');
  });

  it('nome só de espaços, ou maior que 120 caracteres, é recusado sem criar conta', async () => {
    const branco = await registrar({ email: 'bia@exemplo.com', name: '    ' });
    expect(branco.status).toBe(400);
    expect(branco.body.error.code).toBe('PORTAL_INVALID_NAME');
    const longo = await registrar({ email: 'bia@exemplo.com', name: 'x'.repeat(121) });
    expect(longo.status).toBe(400);
    expect(contas()).toBe(0);
  });

  it('o convite do balcão sem nome digitado usa o nome do cadastro que a loja fez', async () => {
    const db = getConnection();
    const agora = new Date().toISOString();
    db.prepare(
      `INSERT INTO core_customers (id, company_id, name, active, created_at, updated_at, origin)
       VALUES ('cli-1', 'gringa', 'Joana do Balcão', 1, ?, ?, 'balcao')`,
    ).run(agora, agora);
    const convite = emitirConvitePortal('gringa', 'cli-1');
    const res = await registrar({ email: 'joana@exemplo.com', code: convite.code });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const linha = db
      .prepare('SELECT name FROM core_customer_accounts WHERE email = ?')
      .get('joana@exemplo.com') as { name: string };
    expect(linha.name).toBe('Joana do Balcão');
  });
});

describe('GAP-PRD-192 — e-mail sintaticamente válido', () => {
  it.each(['ana@', '@exemplo.com', 'ana@exemplo', 'ana exemplo@x.com', 'ana@@x.com', 'ana..b@x.com', 'ana@-x.com'])(
    '"%s" é recusado',
    async (email) => {
      const res = await registrar({ email, name: 'Ana' });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('PORTAL_INVALID_EMAIL');
    },
  );

  it('endereços reais passam', () => {
    for (const ok of ['ana@exemplo.com', 'ana.paula+loja@exemplo.com.br', 'a_b-c@sub.dominio.io']) {
      expect(emailValido(ok), ok).toBe(true);
    }
  });
});

describe('GAP-PRD-192 — senha que não é das primeiras que se tenta', () => {
  it.each([
    ['sequência', '12345678'],
    ['sequência descendo', '87654321'],
    ['repetição', 'aaaaaaaa'],
    ['a mais usada do Brasil', 'senha123'],
    ['com maiúscula não muda nada', 'Senha123'],
    ['clássica', 'Password1'],
    ['teclado', 'qwerty123'],
    ['time', 'flamengo'],
  ])('%s (%s) é recusada com 400, sem criar conta', async (_caso, senha) => {
    const res = await registrar({ email: 'ana@exemplo.com', name: 'Ana', password: senha });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('PORTAL_WEAK_PASSWORD');
    expect(contas()).toBe(0);
  });

  it('o e-mail como senha é recusado', async () => {
    const res = await registrar({
      email: 'joao.silva@exemplo.com',
      name: 'João',
      password: 'JoaoSilva2026',
    });
    expect(res.status).toBe(400);
    expect(res.body.error.message).toMatch(/e-mail/);
  });

  it('senha curta e senha de mais de 128 caracteres são recusadas', async () => {
    expect((await registrar({ email: 'a1@exemplo.com', password: 'Curta@1' })).status).toBe(400);
    expect((await registrar({ email: 'a2@exemplo.com', password: 'x'.repeat(100) + 'y'.repeat(29) })).status).toBe(400);
  });

  it('frase comprida e diferente passa', () => {
    expect(motivoDeSenhaFraca('cavalo-bateria-grampo', { email: 'ana@exemplo.com' })).toBeNull();
    expect(motivoDeSenhaFraca('Portal@2026', { email: 'ana@exemplo.com' })).toBeNull();
  });

  it('a troca de senha logada e a redefinição pelo link seguem a mesma regra', async () => {
    const reg = await registrar({ email: 'ana@exemplo.com', name: 'Ana' });
    confirmarEmail({ accountId: reg.body.account.id, codigo: codigoDaCaixa('ana@exemplo.com') });

    const troca = await request(app)
      .post(`${BASE}/senha`)
      .set('x-portal-token', reg.body.token)
      .send({ currentPassword: SENHA, newPassword: 'senha123' });
    expect(troca.status).toBe(400);
    expect(troca.body.error.code).toBe('PORTAL_WEAK_PASSWORD');

    await request(app).post(`${BASE}/recuperar-senha`).send({ email: 'ana@exemplo.com' });
    const link = getConnection()
      .prepare(`SELECT id FROM core_email_queue WHERE template = 'recuperacao_senha'`)
      .get() as { id: string };
    const token = textoDeEntrega(link.id)!.match(/token=([\w-]+)/)![1];
    const fraca = await request(app).post(`${BASE}/redefinir-senha`).send({ token, password: '12345678' });
    expect(fraca.status).toBe(400);
    expect(fraca.body.error.code).toBe('PORTAL_WEAK_PASSWORD');
    // A recusa não gasta o link: com uma senha boa, ele ainda vale.
    const boa = await request(app).post(`${BASE}/redefinir-senha`).send({ token, password: 'Outra-Serra-2027' });
    expect(boa.status).toBe(200);
  });
});

describe('GAP-PRD-192 — teto de cadastros por origem', () => {
  it('10 por hora da mesma origem; a 11ª tentativa é 429 e não cria conta', async () => {
    for (let i = 0; i < 10; i += 1) {
      const r = await registrar({ email: `pessoa${i}@exemplo.com`, name: `Pessoa ${i}` });
      expect(r.status, JSON.stringify(r.body)).toBe(201);
    }
    const onze = await registrar({ email: 'pessoa10@exemplo.com', name: 'Pessoa 10' });
    expect(onze.status).toBe(429);
    expect(onze.body.error.code).toBe('PORTAL_LIMITE_CADASTRO');
    expect(onze.body.error.details.tenteEmMinutos).toBeGreaterThan(0);
    expect(contas()).toBe(10);

    // Outra origem continua podendo criar.
    const outra = await registrar({ email: 'vizinho@exemplo.com', name: 'Vizinho' }, '198.51.100.7');
    expect(outra.status).toBe(201);
  });

  it('e-mail já cadastrado também conta (a 409 revela quem tem conta)', async () => {
    await registrar({ email: 'ana@exemplo.com', name: 'Ana' });
    for (let i = 0; i < 9; i += 1) {
      expect((await registrar({ email: 'ana@exemplo.com', name: 'Ana' })).status).toBe(409);
    }
    expect((await registrar({ email: 'ana@exemplo.com', name: 'Ana' })).status).toBe(429);
  });

  it('tentativa recusada por validação (senha fraca) não gasta o teto', async () => {
    for (let i = 0; i < 12; i += 1) {
      expect((await registrar({ email: 'ana@exemplo.com', password: '12345678' })).status).toBe(400);
    }
    expect((await registrar({ email: 'ana@exemplo.com', name: 'Ana' })).status).toBe(201);
  });

  it('passada a hora, a origem volta a poder criar', async () => {
    for (let i = 0; i < 10; i += 1) await registrar({ email: `p${i}@exemplo.com`, name: 'P' });
    expect((await registrar({ email: 'depois@exemplo.com', name: 'D' })).status).toBe(429);
    getConnection()
      .prepare('UPDATE core_portal_limites SET created_at = ?')
      .run(new Date(Date.now() - 61 * 60 * 1000).toISOString());
    expect((await registrar({ email: 'depois@exemplo.com', name: 'D' })).status).toBe(201);
  });

  it('o banco guarda a impressão digital da origem, nunca o IP', async () => {
    await registrar({ email: 'ana@exemplo.com', name: 'Ana' }, '203.0.113.99');
    const linhas = getConnection().prepare('SELECT * FROM core_portal_limites').all() as Record<string, string>[];
    expect(linhas).toHaveLength(1);
    expect(JSON.stringify(linhas)).not.toContain('203.0.113.99');
    expect(linhas[0].chave).toMatch(/^[0-9a-f]{64}$/);
  });
});
