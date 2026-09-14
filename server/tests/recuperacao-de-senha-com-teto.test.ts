/**
 * GAP-PRD-116 — A RECUPERAÇÃO DE SENHA TEM TETO POR CONTA, E SÓ O ÚLTIMO LINK
 * VALE.
 *
 * A auditoria pediu a recuperação dez vezes seguidas: dez e-mails na fila
 * para o mesmo endereço e dez tokens vivos ao mesmo tempo (uma hora cada).
 * Qualquer pessoa bombardeava a caixa de qualquer cliente cadastrado, e a
 * reputação do remetente da loja pagava a conta.
 *
 * A regra, no molde do código de verificação (rodada 50):
 *   - pedido repetido em 2 minutos não gera outro link (o clique duplo, a
 *     impaciência) — a resposta é a mesma;
 *   - no máximo 3 links por conta por hora — o 4º pedido some em silêncio,
 *     com a MESMA resposta: um 429 aqui diria a quem digita um e-mail
 *     qualquer que aquela conta existe;
 *   - cada link novo invalida os anteriores ainda não usados;
 *   - 10 pedidos por hora da mesma origem, qualquer e-mail (429 — este não
 *     revela conta nenhuma, conta requisições).
 */
process.env.DEVORA_TRUST_PROXY = '1';

import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { resetDbForTests } from '../src/db/database.js';
import { getConnection } from '../src/db/sqlite.js';
import { upsertCompany } from '../src/services/auth/IdentityService.js';
import { registerCustomerAccount } from '../src/services/core/CustomerPortalService.js';
import { textoDeEntrega } from '../src/services/notifications/EmailService.js';

const app = createApp();
const BASE = '/api/v1/loja/portal';

function pedir(email: string, origem = '203.0.113.20') {
  return request(app)
    .post(`${BASE}/recuperar-senha`)
    .set('X-Forwarded-For', origem)
    .send({ email });
}

function emailsDeRecuperacao(para = 'ana@exemplo.com'): string[] {
  return (
    getConnection()
      .prepare(
        `SELECT id FROM core_email_queue
          WHERE template = 'recuperacao_senha' AND to_address = ? ORDER BY created_at`,
      )
      .all(para) as { id: string }[]
  ).map((l) => textoDeEntrega(l.id)!.match(/token=([\w-]+)/)![1]);
}

function tokensVivos(): number {
  return (
    getConnection()
      .prepare(
        `SELECT COUNT(*) c FROM core_customer_password_resets
          WHERE used_at IS NULL AND expires_at > ?`,
      )
      .get(new Date().toISOString()) as { c: number }
  ).c;
}

/** O relógio do teste: empurra para trás o que já foi pedido. */
function envelhecerPedidos(minutos: number) {
  const db = getConnection();
  const linhas = db.prepare('SELECT id, created_at FROM core_customer_password_resets').all() as {
    id: string;
    created_at: string;
  }[];
  for (const l of linhas) {
    db.prepare('UPDATE core_customer_password_resets SET created_at = ? WHERE id = ?').run(
      new Date(new Date(l.created_at).getTime() - minutos * 60_000).toISOString(),
      l.id,
    );
  }
}

beforeEach(async () => {
  resetDbForTests();
  upsertCompany({ id: 'gringa', slug: 'gringa', legalName: 'Gringa Ltda', tradeName: 'Gringa' });
  await registerCustomerAccount({
    email: 'ana@exemplo.com',
    password: 'Casa-da-Serra-2026',
    termsAccepted: true,
  });
});

describe('GAP-PRD-116 — dez pedidos seguidos', () => {
  it('geram UM e-mail e UM link vivo, e todas as respostas são iguais', async () => {
    const respostas = [];
    for (let i = 0; i < 10; i += 1) respostas.push(await pedir('ana@exemplo.com'));

    expect(respostas.every((r) => r.status === 200)).toBe(true);
    expect(new Set(respostas.map((r) => JSON.stringify(r.body))).size).toBe(1);
    expect(emailsDeRecuperacao()).toHaveLength(1);
    expect(tokensVivos()).toBe(1);
  });
});

describe('GAP-PRD-116 — teto de 3 links por conta por hora', () => {
  it('espaçados, o 4º pedido da hora não gera e-mail — e responde igual', async () => {
    const primeira = await pedir('ana@exemplo.com');
    for (let i = 0; i < 3; i += 1) {
      envelhecerPedidos(5);
      const r = await pedir('ana@exemplo.com');
      expect(r.status).toBe(200);
      expect(r.body).toEqual(primeira.body);
    }
    expect(emailsDeRecuperacao()).toHaveLength(3);
  });

  it('passada a hora, a conta volta a receber link', async () => {
    await pedir('ana@exemplo.com');
    envelhecerPedidos(5);
    await pedir('ana@exemplo.com');
    envelhecerPedidos(5);
    await pedir('ana@exemplo.com');
    expect(emailsDeRecuperacao()).toHaveLength(3);
    envelhecerPedidos(61);
    await pedir('ana@exemplo.com');
    expect(emailsDeRecuperacao()).toHaveLength(4);
  });

  it('a conta que atingiu o teto responde exatamente como e-mail que não existe', async () => {
    for (let i = 0; i < 3; i += 1) {
      await pedir('ana@exemplo.com');
      envelhecerPedidos(5);
    }
    const noTeto = await pedir('ana@exemplo.com');
    const inexistente = await pedir('ninguem@exemplo.com');
    expect(noTeto.status).toBe(inexistente.status);
    expect(noTeto.body).toEqual(inexistente.body);
  });
});

describe('GAP-PRD-116 — só o último link vale', () => {
  it('pedir de novo invalida o link anterior; o novo redefine', async () => {
    await pedir('ana@exemplo.com');
    envelhecerPedidos(5);
    await pedir('ana@exemplo.com');
    const [antigo, novo] = emailsDeRecuperacao();
    expect(tokensVivos()).toBe(1);

    const comAntigo = await request(app)
      .post(`${BASE}/redefinir-senha`)
      .send({ token: antigo, password: 'Outra-Serra-2027' });
    expect(comAntigo.status).toBe(400);
    expect(comAntigo.body.error.code).toBe('PORTAL_RESET_INVALID');

    const comNovo = await request(app)
      .post(`${BASE}/redefinir-senha`)
      .send({ token: novo, password: 'Outra-Serra-2027' });
    expect(comNovo.status).toBe(200);
  });
});

describe('GAP-PRD-116 — teto por origem', () => {
  it('10 pedidos por hora da mesma origem, qualquer e-mail; o 11º é 429', async () => {
    for (let i = 0; i < 10; i += 1) {
      expect((await pedir(`alguem${i}@exemplo.com`)).status).toBe(200);
    }
    const onze = await pedir('ana@exemplo.com');
    expect(onze.status).toBe(429);
    expect(onze.body.error.code).toBe('PORTAL_LIMITE_RECUPERACAO');
    // O 429 não gerou link para a conta.
    expect(emailsDeRecuperacao()).toHaveLength(0);

    // De outra origem, a dona da conta ainda consegue pedir.
    expect((await pedir('ana@exemplo.com', '198.51.100.8')).status).toBe(200);
    expect(emailsDeRecuperacao()).toHaveLength(1);
  });
});
