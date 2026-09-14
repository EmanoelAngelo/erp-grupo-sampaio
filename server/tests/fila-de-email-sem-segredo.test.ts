/**
 * ============================================================================
 * O SEGREDO DO CLIENTE NÃO PASSA PELA TELA DO GERENTE (GAP-PRD-007)
 * ============================================================================
 *
 * O ATAQUE, como a auditoria o reproduziu de ponta a ponta: um gerente_loja
 * pede "esqueci minha senha" com o e-mail de um cliente do grupo, abre
 * E-mails para o cliente (`GET /core/emails`), lê o link com `token=` no
 * corpo da mensagem pendente — sem SMTP ela fica ali, e o gerente lê ANTES do
 * cliente — e redefine a senha. O código de verificação de 6 dígitos estava
 * igualmente legível. A redação existia, mas só no `payload`; o `body_text`,
 * que é o que a rota devolve, carregava o segredo.
 *
 * O CONSERTO: o corpo guardado tem um marcador no lugar do segredo, e o
 * segredo vai selado (cofre AES-GCM) para `core_email_segredos`, com prazo.
 * Só o carteiro abre, para entregar — e apaga. Este arquivo prova:
 *
 *   - a rota do gerente não devolve o link nem o código, em lugar nenhum da
 *     resposta — e o ataque, repetido, não acha token para usar;
 *   - o banco em repouso não guarda o segredo em claro (nem corpo, nem
 *     payload, nem a coluna do cofre);
 *   - o CLIENTE continua recebendo o link e o código de verdade, e o link
 *     funciona;
 *   - entregue, desistido ou vencido, o segredo some do banco;
 *   - mensagem gravada ANTES do conserto (segredo em claro) sai mascarada na
 *     tela, e o corpo é mascarado no banco quando ela termina;
 *   - a rotação da chave do cofre enxerga o segredo pendente.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import { createApp } from '../src/app.js';
import { resetDbForTests } from '../src/db/database.js';
import { ensureCoreSchema } from '../src/db/schema.js';
import { getConnection } from '../src/db/sqlite.js';
import { inventariarSegredos } from '../src/db/secretsInventory.js';
import { upsertCompany } from '../src/services/auth/IdentityService.js';
import {
  pedirRecuperacaoSenha,
  pedirVerificacaoEmail,
  redefinirSenhaComToken,
  registerCustomerAccount,
  loginCustomer,
} from '../src/services/core/CustomerPortalService.js';
import {
  MARCA_DO_CONTEUDO_PROTEGIDO,
  flushEmailQueue,
  queuePasswordResetEmail,
  textoDeEntrega,
  type CarteiroSmtp,
  type MensagemSmtp,
} from '../src/services/notifications/EmailService.js';
import { loginForTest } from './helpers/auth.js';

const app = createApp();
const EMPRESA = 'preco-justo';
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
  process.env.EMAIL_SMTP_PASSWORD = 'senha-de-app-de-teste';
}

function carteiroDublado(): CarteiroSmtp & { enviados: MensagemSmtp[] } {
  const enviados: MensagemSmtp[] = [];
  return {
    enviados,
    enviar(msg: MensagemSmtp): Promise<void> {
      enviados.push(msg);
      return Promise.resolve();
    },
  };
}

async function tokenDoGerente(): Promise<string> {
  const r = await loginForTest(app, {
    userId: 'gerente',
    companyId: EMPRESA,
    profileCodes: ['gerente_loja'],
  });
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return r.body.accessToken as string;
}

function idDaUltima(template: string): string {
  const linha = getConnection()
    .prepare(`SELECT id FROM core_email_queue WHERE template = ? ORDER BY rowid DESC LIMIT 1`)
    .get(template) as { id: string } | undefined;
  expect(linha, `nenhuma mensagem ${template} na fila`).toBeTruthy();
  return linha!.id;
}

/** O que o CLIENTE lê na caixa dele: a montagem do carteiro. */
function tokenNaCaixaDoCliente(): string {
  const texto = textoDeEntrega(idDaUltima('recuperacao_senha'));
  const token = texto?.match(/token=([A-Za-z0-9_-]+)/)?.[1];
  expect(token, 'o link com token não chegou ao cliente').toBeTruthy();
  return token!;
}

function codigoNaCaixaDoCliente(): string {
  const texto = textoDeEntrega(idDaUltima('verificacao_email'));
  const codigo = texto?.match(/é: (\d{6})/)?.[1];
  expect(codigo, 'o código não chegou ao cliente').toBeTruthy();
  return codigo!;
}

function tudoQueOBancoGuardaEmClaro(): string {
  const db = getConnection();
  const fila = db.prepare('SELECT subject, body_text, payload, last_error FROM core_email_queue').all();
  const cofre = db.prepare('SELECT segredo_cifrado FROM core_email_segredos').all();
  return JSON.stringify({ fila, cofre });
}

beforeEach(() => {
  resetDbForTests();
  ensureCoreSchema();
  semCredencial();
  // A empresa que "assina" os e-mails da conta (primeira ativa do grupo).
  upsertCompany({ id: EMPRESA, slug: EMPRESA, legalName: 'Preço Justo Ltda', tradeName: 'Preço Justo' });
});

afterEach(() => {
  for (const v of EMAIL_VARS) {
    const original = originais.get(v);
    if (original === undefined) delete process.env[v];
    else process.env[v] = original;
  }
});

describe('o ataque da auditoria, repetido', () => {
  it('o gerente_loja lê a fila e NÃO acha o link de redefinição nem o código', async () => {
    const tokenGerente = await tokenDoGerente();
    await registerCustomerAccount({
      email: 'vitima@exemplo.com',
      password: 'senha-da-vitima-8',
      termsAccepted: true,
    });
    pedirRecuperacaoSenha('vitima@exemplo.com');

    const tokenReal = tokenNaCaixaDoCliente();
    const codigoReal = codigoNaCaixaDoCliente();

    const r = await request(app)
      .get('/api/v1/core/emails')
      .set('Authorization', `Bearer ${tokenGerente}`);
    expect(r.status, JSON.stringify(r.body)).toBe(200);

    const resposta = JSON.stringify(r.body);
    // Nem no corpo, nem em campo nenhum da resposta.
    expect(resposta).not.toContain(tokenReal);
    expect(resposta).not.toContain(codigoReal);
    expect(resposta).not.toMatch(/token=/);

    // O que o gerente vê: que houve o pedido — com o marcador no lugar.
    const itens = r.body.items as { template: string; bodyText: string }[];
    const reset = itens.find((i) => i.template === 'recuperacao_senha');
    const verif = itens.find((i) => i.template === 'verificacao_email');
    expect(reset?.bodyText).toContain(MARCA_DO_CONTEUDO_PROTEGIDO);
    expect(verif?.bodyText).toContain(MARCA_DO_CONTEUDO_PROTEGIDO);

    // O passo seguinte do ataque — achar o token no corpo — não tem o que achar.
    const achado = reset?.bodyText.match(/token=([A-Za-z0-9_-]+)/)?.[1];
    expect(achado).toBeUndefined();
  });

  it('o banco em repouso não guarda o link nem o código em claro', async () => {
    await registerCustomerAccount({
      email: 'vitima@exemplo.com',
      password: 'senha-da-vitima-8',
      termsAccepted: true,
    });
    pedirRecuperacaoSenha('vitima@exemplo.com');
    const tokenReal = tokenNaCaixaDoCliente();
    const codigoReal = codigoNaCaixaDoCliente();

    const guardado = tudoQueOBancoGuardaEmClaro();
    expect(guardado).not.toContain(tokenReal);
    expect(guardado).not.toContain(codigoReal);
    expect(guardado).not.toMatch(/token=/);
  });
});

describe('o cliente continua recebendo — e o link funciona', () => {
  it('o carteiro entrega o link e o código de verdade, e depois o segredo some', async () => {
    const sessao = await registerCustomerAccount({
      email: 'ana@exemplo.com',
      password: 'senha-antiga-8',
      termsAccepted: true,
    });
    pedirRecuperacaoSenha('ana@exemplo.com');

    comCredencial();
    const carteiro = carteiroDublado();
    const r = await flushEmailQueue({ carteiro });
    expect(r.sent).toBeGreaterThanOrEqual(3); // conta criada, código, recuperação

    const reset = carteiro.enviados.find((m) => m.subject.includes('recuperação de senha'));
    const verif = carteiro.enviados.find((m) => m.subject.includes('confirme seu e-mail'));
    const token = reset?.text.match(/token=([A-Za-z0-9_-]+)/)?.[1];
    expect(token, 'o e-mail entregue precisa levar o link').toBeTruthy();
    expect(reset?.text).not.toContain(MARCA_DO_CONTEUDO_PROTEGIDO);
    expect(verif?.text).toMatch(/é: \d{6}/);

    // Entregue: nada mais do segredo no banco — nem cifrado.
    const cofre = getConnection().prepare('SELECT COUNT(*) AS n FROM core_email_segredos').get() as {
      n: number;
    };
    expect(Number(cofre.n)).toBe(0);
    expect(textoDeEntrega(idDaUltima('recuperacao_senha'))).toBeNull();

    // E o link que o cliente recebeu redefine a senha.
    await redefinirSenhaComToken({ token: token!, password: 'senha-nova-do-link-8' });
    const entrou = await loginCustomer({ email: 'ana@exemplo.com', password: 'senha-nova-do-link-8' });
    expect(entrou.account.id).toBe(sessao.account.id);
  });
});

describe('o prazo do segredo anda, com ou sem SMTP', () => {
  it('link vencido antes de sair: a mensagem desiste dizendo por quê, e o segredo é apagado', async () => {
    await registerCustomerAccount({
      email: 'ana@exemplo.com',
      password: 'senha-antiga-8',
      termsAccepted: true,
    });
    pedirRecuperacaoSenha('ana@exemplo.com');
    const id = idDaUltima('recuperacao_senha');

    // Sem credencial, duas horas depois.
    const r = await flushEmailQueue({ agora: new Date(Date.now() + 2 * 60 * 60 * 1000) });
    expect(r.readiness).toBe('READY_FOR_CREDENTIAL');

    const linha = getConnection()
      .prepare('SELECT status, last_error FROM core_email_queue WHERE id = ?')
      .get(id) as { status: string; last_error: string };
    expect(linha.status).toBe('failed');
    expect(linha.last_error).toMatch(/venceu/);
    expect(linha.last_error).toMatch(/Esqueci minha senha/);
    const cofre = getConnection().prepare('SELECT COUNT(*) AS n FROM core_email_segredos').get() as {
      n: number;
    };
    expect(Number(cofre.n)).toBe(0);
  });

  it('dentro do prazo e sem SMTP, nada muda: o segredo espera o carteiro', async () => {
    await registerCustomerAccount({
      email: 'ana@exemplo.com',
      password: 'senha-antiga-8',
      termsAccepted: true,
    });
    pedirVerificacaoEmail(
      (
        getConnection()
          .prepare("SELECT id FROM core_customer_accounts WHERE email = 'ana@exemplo.com'")
          .get() as { id: string }
      ).id,
    );
    await flushEmailQueue();
    const pendentes = getConnection()
      .prepare("SELECT COUNT(*) AS n FROM core_email_queue WHERE status = 'pending'")
      .get() as { n: number };
    expect(Number(pendentes.n)).toBeGreaterThanOrEqual(2);
    expect(codigoNaCaixaDoCliente()).toMatch(/^\d{6}$/);
  });
});

describe('o que foi gravado antes do conserto', () => {
  function legado(template: string, corpo: string, status: string): string {
    const id = randomUUID();
    getConnection()
      .prepare(
        `INSERT INTO core_email_queue
           (id, company_id, template, to_address, subject, body_text, payload, status, attempts,
            dedupe_key, created_at)
         VALUES (?, ?, ?, 'vitima@exemplo.com', 'assunto', ?, '{}', ?, 0, ?, ?)`,
      )
      .run(id, EMPRESA, template, corpo, status, `legado-${id}`, new Date().toISOString());
    return id;
  }

  it('a tela mascara o link e o código que ficaram em claro na linha antiga', async () => {
    const tokenGerente = await tokenDoGerente();
    legado(
      'recuperacao_senha',
      'Abra este link para escolher uma nova senha (vale por 1 hora):\n'
        + 'https://loja.exemplo/redefinir-senha?token=AbCdEf123_-xyz\n\nGrupo Sampaio',
      'sent',
    );
    legado('verificacao_email', 'Seu código de confirmação no Grupo Sampaio é: 482913\n', 'pending');

    const r = await request(app)
      .get('/api/v1/core/emails')
      .set('Authorization', `Bearer ${tokenGerente}`);
    expect(r.status).toBe(200);
    const resposta = JSON.stringify(r.body);
    expect(resposta).not.toContain('AbCdEf123_-xyz');
    expect(resposta).not.toContain('482913');
    expect(resposta).not.toMatch(/token=/);
  });

  it('a pendente antiga ainda sai inteira ao cliente — e o corpo guardado é mascarado depois', async () => {
    const id = legado(
      'recuperacao_senha',
      'Abra este link:\nhttps://loja.exemplo/redefinir-senha?token=LegadoPendente99\n',
      'pending',
    );
    comCredencial();
    const carteiro = carteiroDublado();
    await flushEmailQueue({ carteiro });
    expect(carteiro.enviados[0]?.text).toContain('token=LegadoPendente99');

    const corpo = getConnection()
      .prepare('SELECT body_text FROM core_email_queue WHERE id = ?')
      .get(id) as { body_text: string };
    expect(corpo.body_text).not.toContain('LegadoPendente99');
    expect(corpo.body_text).toContain(MARCA_DO_CONTEUDO_PROTEGIDO);
  });

  it('corpo com marcador e sem segredo não sai como "[protegido]" — desiste dizendo o que fazer', async () => {
    const id = legado(
      'recuperacao_senha',
      `Abra este link:\n${MARCA_DO_CONTEUDO_PROTEGIDO}\n`,
      'pending',
    );
    comCredencial();
    const carteiro = carteiroDublado();
    await flushEmailQueue({ carteiro });
    expect(carteiro.enviados).toHaveLength(0);
    const linha = getConnection()
      .prepare('SELECT status, last_error FROM core_email_queue WHERE id = ?')
      .get(id) as { status: string; last_error: string };
    expect(linha.status).toBe('failed');
    expect(linha.last_error).toMatch(/pedir outro/);
  });
});

describe('o cofre sabe que o segredo existe', () => {
  it('o inventário da rotação enxerga o segredo pendente, e ele abre com a chave atual', async () => {
    const id = queuePasswordResetEmail({
      companyId: EMPRESA,
      toAddress: 'ana@exemplo.com',
      resetLink: 'https://loja.exemplo/redefinir-senha?token=paraInventario',
      dedupeKey: 'inventario-1',
    });
    expect(id).toBeTruthy();
    const achados = inventariarSegredos().filter((s) => s.store === 'core_email_segredos');
    expect(achados).toHaveLength(1);
    expect(achados[0].rowId).toBe(id);
    expect(achados[0].companyId).toBe(EMPRESA);
    expect(achados[0].decryptableWithCurrentKey).toBe(true);
  });
});
