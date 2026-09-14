/**
 * ============================================================================
 * O E-MAIL NUNCA DERRUBA O FATO — em TODOS os disparos (GAP-PRD-201)
 * ============================================================================
 *
 * O contrato estava escrito só no caminho do pedido: `enfileirarEmailDoPedido`
 * embrulha `queueEmail` num try/catch ("a venda vale mais que a notificação").
 * Os avisos da CONTA chamavam as funções da fila direto, DENTRO da transação
 * do registro e da troca de senha — e uma exceção do INSERT na fila desfazia a
 * conta recém-criada ou a senha recém-trocada.
 *
 * O conserto mora na fila, e não em cada chamador: as funções de notificação
 * (`queueEmail`, `queuePasswordResetEmail`, `queueVerificacaoEmail`,
 * `queueContaCriadaEmail`, `queueSenhaAlteradaEmail`) passaram a NUNCA lançar.
 * Falha vira log e `null`, com o INSERT desfeito num SAVEPOINT próprio — o fato
 * de quem chamou segue inteiro.
 *
 * COMO A FALHA É PROVOCADA: um gatilho que recusa todo INSERT na fila. É o
 * "schema inconsistente" da ficha, e alcança exatamente o ponto que quebrava
 * (o INSERT dentro da transação do fato), sem dublar módulo nenhum.
 *
 * O que NÃO entra no contrato, de propósito: `queuePacoteContadorEmail`. Ali o
 * e-mail É o fato — o contador clicou "enviar o mês" —, e engolir a falha
 * responderia "enviado" a um envio que não existe.
 */
import { createHash, randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetDbForTests } from '../src/db/database.js';
import { ensureCoreSchema } from '../src/db/schema.js';
import { getConnection, withTransaction } from '../src/db/sqlite.js';
import { upsertCompany } from '../src/services/auth/IdentityService.js';
import {
  pedirRecuperacaoSenha,
  pedirVerificacaoEmail,
  redefinirSenhaComToken,
  registerCustomerAccount,
  registerWithInvite,
} from '../src/services/core/CustomerPortalService.js';
import { changePassword } from '../src/services/core/CustomerAccountService.js';
import {
  queueContaCriadaEmail,
  queueEmail,
  queuePacoteContadorEmail,
  queuePasswordResetEmail,
  queueSenhaAlteradaEmail,
  queueVerificacaoEmail,
} from '../src/services/notifications/EmailService.js';

let gringa: string;

function quebrarAFila(): void {
  getConnection().exec(
    `CREATE TRIGGER IF NOT EXISTS fila_quebrada BEFORE INSERT ON core_email_queue
     BEGIN SELECT RAISE(ABORT, 'fila de e-mail indisponivel'); END;`,
  );
}

function consertarAFila(): void {
  getConnection().exec('DROP TRIGGER IF EXISTS fila_quebrada;');
}

function contas(email: string): number {
  return Number(
    (
      getConnection()
        .prepare('SELECT COUNT(*) AS n FROM core_customer_accounts WHERE email = ?')
        .get(email) as { n: number }
    ).n,
  );
}

function hashDaSenha(accountId: string): string {
  return (
    getConnection()
      .prepare('SELECT password_hash FROM core_customer_accounts WHERE id = ?')
      .get(accountId) as { password_hash: string }
  ).password_hash;
}

let erros: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  resetDbForTests();
  ensureCoreSchema();
  consertarAFila();
  gringa = upsertCompany({ slug: 'gringa', tradeName: 'Gringa', legalName: 'Gringa Ltda', kind: 'retail' });
  erros = vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  consertarAFila();
  erros.mockRestore();
});

describe('os avisos da conta não desfazem a conta', () => {
  it('registro aberto: a fila recusa, a conta nasce mesmo assim', async () => {
    quebrarAFila();
    const sessao = await registerCustomerAccount({
      email: 'ana@exemplo.com',
      password: 'senha-forte-8',
      termsAccepted: true,
    });
    expect(sessao.account.id).toBeTruthy();
    expect(contas('ana@exemplo.com')).toBe(1);
    // "Registra": a falha deixa rastro no log, sem virar exceção.
    expect(erros).toHaveBeenCalled();
    expect(String(erros.mock.calls[0]?.[0])).toContain('email_nao_enfileirado');
  });

  it('convite do balcão: o vínculo e a conta ficam, mesmo sem aviso', async () => {
    const agora = new Date().toISOString();
    const clienteId = randomUUID();
    getConnection()
      .prepare(
        `INSERT INTO core_customers (id, company_id, name, active, created_at, updated_at)
         VALUES (?, ?, 'Dona da Moto', 1, ?, ?)`,
      )
      .run(clienteId, gringa, agora, agora);
    quebrarAFila();
    await registerWithInvite({
      email: 'balcao@exemplo.com',
      password: 'senha-forte-8',
      customerId: clienteId,
      companyId: gringa,
      termsAccepted: true,
    });
    expect(contas('balcao@exemplo.com')).toBe(1);
  });

  it('troca de senha logada: a senha nova vale, mesmo sem o aviso', async () => {
    const sessao = await registerCustomerAccount({
      email: 'ana@exemplo.com',
      password: 'senha-antiga-8',
      termsAccepted: true,
    });
    const antes = hashDaSenha(sessao.account.id);
    quebrarAFila();
    await changePassword({
      accountId: sessao.account.id,
      currentSessionToken: sessao.token,
      currentPassword: 'senha-antiga-8',
      newPassword: 'senha-novissima-8',
    });
    expect(hashDaSenha(sessao.account.id)).not.toBe(antes);
  });

  it('redefinição pelo link: a senha nova vale, mesmo sem o aviso', async () => {
    const sessao = await registerCustomerAccount({
      email: 'ana@exemplo.com',
      password: 'senha-antiga-8',
      termsAccepted: true,
    });
    const token = 'token-de-teste-conhecido';
    getConnection()
      .prepare(
        `INSERT INTO core_customer_password_resets
           (id, account_id, token_hash, expires_at, used_at, created_at)
         VALUES (?, ?, ?, ?, NULL, ?)`,
      )
      .run(
        randomUUID(),
        sessao.account.id,
        createHash('sha256').update(token).digest('hex'),
        new Date(Date.now() + 3_600_000).toISOString(),
        new Date().toISOString(),
      );
    const antes = hashDaSenha(sessao.account.id);
    quebrarAFila();
    await redefinirSenhaComToken({ token, password: 'senha-do-link-8' });
    expect(hashDaSenha(sessao.account.id)).not.toBe(antes);
  });

  it('pedir recuperação e pedir código novo não estouram na cara do cliente', async () => {
    const sessao = await registerCustomerAccount({
      email: 'ana@exemplo.com',
      password: 'senha-antiga-8',
      termsAccepted: true,
    });
    quebrarAFila();
    expect(() => pedirRecuperacaoSenha('ana@exemplo.com')).not.toThrow();
    expect(() => pedirVerificacaoEmail(sessao.account.id)).not.toThrow();
  });
});

describe('o contrato mora na fila', () => {
  it('cada função de notificação devolve null em vez de lançar — empresa inexistente (FK)', () => {
    // Sem gatilho: a chave estrangeira de company_id é a falha real.
    const base = { companyId: 'empresa-que-nao-existe', toAddress: 'ana@exemplo.com' };
    expect(queueContaCriadaEmail({ ...base, dedupeKey: 'k1' })).toBeNull();
    expect(queueSenhaAlteradaEmail({ ...base, dedupeKey: 'k2' })).toBeNull();
    expect(queueVerificacaoEmail({ ...base, codigo: '123456', dedupeKey: 'k3' })).toBeNull();
    expect(
      queuePasswordResetEmail({ ...base, resetLink: 'https://x/redefinir?token=abc', dedupeKey: 'k4' }),
    ).toBeNull();
    expect(
      queueEmail({
        ...base,
        template: 'pagamento_confirmado',
        dedupeKey: 'k5',
        context: { storeName: 'X', customerName: 'Ana', orderNumber: 1, totalCents: 100 },
      }),
    ).toBeNull();
    // Nada meio gravado ficou para trás.
    const n = getConnection().prepare('SELECT COUNT(*) AS n FROM core_email_queue').get() as { n: number };
    expect(Number(n.n)).toBe(0);
  });

  it('dentro da transação do fato, a falha não contamina o que veio antes', () => {
    const db = getConnection();
    const devolveu = withTransaction(() => {
      db.prepare(
        `INSERT INTO core_customers (id, company_id, name, active, created_at, updated_at)
         VALUES ('antes-do-email', ?, 'Fato', 1, datetime('now'), datetime('now'))`,
      ).run(gringa);
      quebrarAFila();
      return queueContaCriadaEmail({ companyId: gringa, toAddress: 'a@b.com', dedupeKey: 'x' });
    });
    expect(devolveu).toBeNull();
    expect(db.prepare("SELECT id FROM core_customers WHERE id = 'antes-do-email'").get()).toBeTruthy();
  });

  it('o pacote do contador CONTINUA lançando — ali o e-mail é o próprio fato', () => {
    quebrarAFila();
    expect(() =>
      queuePacoteContadorEmail({
        companyId: gringa,
        toAddress: 'contador@exemplo.com',
        subject: 'mês',
        bodyText: 'corpo',
        payload: {},
        dedupeKey: 'pacote-1',
      }),
    ).toThrow(/indisponivel/);
  });
});
