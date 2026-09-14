/**
 * "ESQUECI MINHA SENHA" PARA A EQUIPE — GAP-PRD-160.
 *
 * Decisão do dono, com mecanismo pronto e padrão seguro: desligado por
 * operação até um dono ligar; conta de dono nunca recupera por e-mail; código
 * de uso único, 15 minutos, 5 tentativas; resposta sempre igual (sem
 * enumeração); troca derruba as sessões. O código chega pela fila de e-mail —
 * é de lá que o teste o lê, como a pessoa leria da caixa dela.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { resetEnvCacheForTests } from '../src/config/env.js';
import { resetDbForTests } from '../src/db/database.js';
import { getConnection } from '../src/db/sqlite.js';
import {
  linkUserToCompany,
  upsertCompany,
  upsertUser,
} from '../src/services/auth/IdentityService.js';
import { listEmailQueue } from '../src/services/notifications/EmailService.js';
import { decryptFiscalSecret } from '../src/services/fiscal/FiscalSecretVault.js';
import {
  MAX_PEDIDOS_POR_HORA,
  recuperacaoDisponivel,
} from '../src/services/auth/RecuperacaoDeSenhaDaEquipe.js';
import { issueSession } from './helpers/sessao.js';

process.env.DEVORA_JWT_SECRET = 'test-jwt-secret-key';
process.env.DEVORA_ENCRYPTION_KEY = 'test-encryption-key-32-chars!!';

const SENHA_ANTIGA = 'Antiga@Balcao2026';
const SENHA_NOVA = 'Nova@Balcao2026';

let app: ReturnType<typeof createApp>;
let lojaA: string;
let lojaB: string;
let joaoId: string;

function gestorDe(companyId: string): { Authorization: string } {
  const s = issueSession({ userId: 'u-gestor', companyId, profileCodes: ['gestor'] });
  return { Authorization: `Bearer ${s.accessToken}` };
}

async function ligarNa(companyId: string, ligado = true): Promise<void> {
  const res = await request(app)
    .put('/api/v1/core/team/recuperacao-de-senha')
    .set(gestorDe(companyId))
    .send({ emailLigado: ligado });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
}

function filaDoCodigo(): { to_address: string; body_text: string; payload: string }[] {
  return getConnection()
    .prepare(
      `SELECT to_address, body_text, payload FROM core_email_queue
        WHERE template = 'recuperacao_senha_equipe' ORDER BY created_at`,
    )
    .all() as unknown as { to_address: string; body_text: string; payload: string }[];
}

function codigoDaCaixa(): string {
  // O código vai SELADO no cofre da fila (GAP-PRD-007): o corpo guardado leva
  // só o marcador, e é o carteiro que o abre na hora de entregar.
  const linhas = getConnection()
    .prepare(
      `SELECT q.body_text, s.segredo_cifrado FROM core_email_queue q
         JOIN core_email_segredos s ON s.id = q.id
        WHERE q.template = 'recuperacao_senha_equipe' ORDER BY q.created_at`,
    )
    .all() as unknown as { body_text: string; segredo_cifrado: string }[];
  const ultima = linhas[linhas.length - 1];
  if (!ultima) throw new Error('sem código na fila');
  expect(ultima.body_text).not.toMatch(/\d{8}/);
  const codigo = decryptFiscalSecret(ultima.segredo_cifrado);
  expect(codigo).toMatch(/^\d{8}$/);
  return codigo;
}

async function esqueci(identificador: string) {
  return request(app).post('/api/v1/auth/senha/esqueci').send({ identificador });
}

async function recuperar(codigo: string, novaSenha = SENHA_NOVA, identificador = 'joao.caixa') {
  return request(app)
    .post('/api/v1/auth/senha/recuperar')
    .send({ identificador, codigo, novaSenha });
}

async function entrar(senha: string, companyId = lojaA) {
  return request(app)
    .post('/api/v1/auth/login')
    .send({ login: 'joao.caixa', password: senha, companyId });
}

beforeEach(async () => {
  resetEnvCacheForTests();
  resetDbForTests();
  app = createApp();
  lojaA = upsertCompany({ slug: 'loja-a', legalName: 'Loja A Ltda', tradeName: 'Loja A' });
  lojaB = upsertCompany({ slug: 'loja-b', legalName: 'Loja B Ltda', tradeName: 'Loja B' });
  joaoId = await upsertUser({ login: 'joao.caixa', displayName: 'João do Caixa', password: SENHA_ANTIGA });
  getConnection().prepare("UPDATE core_users SET email = 'joao@loja.com.br' WHERE id = ?").run(joaoId);
  linkUserToCompany(joaoId, lojaA, 'operador_caixa_loja', true);
});

describe('desligado por padrão', () => {
  it('sem ninguém ligar, o pedido responde o mesmo 202 e nada vai para a fila', async () => {
    const res = await esqueci('joao.caixa');
    expect(res.status).toBe(202);
    expect(filaDoCodigo()).toHaveLength(0);
  });

  it('a tela de login não oferece o caminho (disponivel: false)', async () => {
    const res = await request(app).get('/api/v1/auth/senha/recuperacao');
    expect(res.status).toBe(200);
    expect(res.body.disponivel).toBe(false);
  });
});

describe('ligada pelo dono na operação', () => {
  it('o código chega pela fila, troca a senha, derruba a sessão e só vale uma vez', async () => {
    await ligarNa(lojaA);
    const antes = getConnection()
      .prepare('SELECT session_version FROM core_users WHERE id = ?')
      .get(joaoId) as { session_version: number };

    expect((await esqueci('joao.caixa')).status).toBe(202);
    const fila = filaDoCodigo();
    expect(fila).toHaveLength(1);
    expect(fila[0].to_address).toBe('joao@loja.com.br');
    expect(fila[0].payload).not.toMatch(/\d{8}/);

    const codigo = codigoDaCaixa();
    const ok = await recuperar(codigo);
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);

    expect((await entrar(SENHA_NOVA)).status).toBe(200);
    expect((await entrar(SENHA_ANTIGA)).status).toBe(401);

    const depois = getConnection()
      .prepare('SELECT session_version, must_change_password FROM core_users WHERE id = ?')
      .get(joaoId) as { session_version: number; must_change_password: number };
    expect(depois.session_version).toBeGreaterThan(antes.session_version);
    expect(depois.must_change_password).toBe(0);

    const denovo = await recuperar(codigo, 'Outra@Senha2026');
    expect(denovo.status).toBe(400);
    expect(denovo.body.error.code).toBe('API_RECOVERY_INVALID');
  });

  it('o pedido pelo E-MAIL também serve', async () => {
    await ligarNa(lojaA);
    await esqueci('JOAO@loja.com.br');
    expect(filaDoCodigo()).toHaveLength(1);
  });

  it('cinco erros queimam o código — o certo, depois, também é recusado', async () => {
    await ligarNa(lojaA);
    await esqueci('joao.caixa');
    const codigo = codigoDaCaixa();
    const errado = codigo === '00000000' ? '11111111' : '00000000';
    for (let i = 0; i < 5; i += 1) {
      expect((await recuperar(errado)).status).toBe(400);
    }
    expect((await recuperar(codigo)).status).toBe(400);
    expect((await entrar(SENHA_ANTIGA)).status).toBe(200);
  });

  it('código vencido é recusado', async () => {
    await ligarNa(lojaA);
    await esqueci('joao.caixa');
    getConnection()
      .prepare("UPDATE core_user_password_resets SET expires_at = '2000-01-01T00:00:00.000Z'")
      .run();
    expect((await recuperar(codigoDaCaixa())).status).toBe(400);
  });

  it('pedido novo aposenta o código anterior', async () => {
    await ligarNa(lojaA);
    await esqueci('joao.caixa');
    const primeiro = codigoDaCaixa();
    await esqueci('joao.caixa');
    const segundo = codigoDaCaixa();
    if (primeiro !== segundo) expect((await recuperar(primeiro)).status).toBe(400);
    expect((await recuperar(segundo)).status).toBe(200);
  });

  it(`mais de ${MAX_PEDIDOS_POR_HORA} pedidos na hora: os excedentes não geram código`, async () => {
    await ligarNa(lojaA);
    for (let i = 0; i < MAX_PEDIDOS_POR_HORA + 2; i += 1) {
      expect((await esqueci('joao.caixa')).status).toBe(202);
    }
    expect(filaDoCodigo()).toHaveLength(MAX_PEDIDOS_POR_HORA);
  });

  it('senha nova fraca é recusada antes de gastar o código', async () => {
    await ligarNa(lojaA);
    await esqueci('joao.caixa');
    const res = await recuperar(codigoDaCaixa(), '123');
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('CORE_PASSWORD_WEAK');
    expect((await recuperar(codigoDaCaixa())).status).toBe(200);
  });
});

describe('as travas que fecham para o lado seguro', () => {
  it('a resposta é a MESMA para conta que existe e para conta que não existe', async () => {
    await ligarNa(lojaA);
    const existe = await esqueci('joao.caixa');
    const naoExiste = await esqueci('ninguem.aqui');
    expect(naoExiste.status).toBe(existe.status);
    expect(naoExiste.body).toEqual(existe.body);
  });

  it('conta que também entra na loja B (recuperação desligada lá) não recebe código', async () => {
    await ligarNa(lojaA);
    linkUserToCompany(joaoId, lojaB, 'operador_caixa_loja', false);
    await esqueci('joao.caixa');
    expect(filaDoCodigo()).toHaveLength(0);
  });

  it('conta de dono (gestor) nunca recupera por e-mail, mesmo com a operação ligada', async () => {
    await ligarNa(lojaA);
    const dono = await upsertUser({ login: 'carlos.gestor', displayName: 'Carlos', password: SENHA_ANTIGA });
    getConnection().prepare("UPDATE core_users SET email = 'carlos@grupo.com.br' WHERE id = ?").run(dono);
    linkUserToCompany(dono, lojaA, 'gestor', true);
    await esqueci('carlos.gestor');
    expect(filaDoCodigo()).toHaveLength(0);
  });

  it('conta desligada não recebe código', async () => {
    await ligarNa(lojaA);
    getConnection().prepare('UPDATE core_users SET active = 0 WHERE id = ?').run(joaoId);
    await esqueci('joao.caixa');
    expect(filaDoCodigo()).toHaveLength(0);
  });

  it('se o dono desliga depois do pedido, o código deixa de valer', async () => {
    await ligarNa(lojaA);
    await esqueci('joao.caixa');
    const codigo = codigoDaCaixa();
    await ligarNa(lojaA, false);
    expect((await recuperar(codigo)).status).toBe(400);
  });

  it('a fila que a gestão lê não mostra o código', async () => {
    await ligarNa(lojaA);
    await esqueci('joao.caixa');
    const codigo = codigoDaCaixa();
    const listada = listEmailQueue(lojaA).find((m) => String(m.template) === 'recuperacao_senha_equipe');
    expect(listada).toBeDefined();
    expect(listada!.bodyText).not.toContain(codigo);
  });
});

describe('a escolha é do dono, e aparece para ele', () => {
  it('gerente não liga (403); gestor liga (200), e fica na trilha', async () => {
    const gerente = issueSession({ userId: 'u-gerente', companyId: lojaA, profileCodes: ['gerente_loja'] });
    const recusado = await request(app)
      .put('/api/v1/core/team/recuperacao-de-senha')
      .set({ Authorization: `Bearer ${gerente.accessToken}` })
      .send({ emailLigado: true });
    expect(recusado.status).toBe(403);

    await ligarNa(lojaA);
    const leitura = await request(app).get('/api/v1/core/team/recuperacao-de-senha').set(gestorDe(lojaA));
    expect(leitura.status).toBe(200);
    expect(leitura.body.emailLigado).toBe(true);
    expect(typeof leitura.body.carteiroPronto).toBe('boolean');
    expect(Array.isArray(leitura.body.faltaNoCarteiro)).toBe(true);

    const trilha = getConnection()
      .prepare("SELECT COUNT(*) AS n FROM core_audit_log WHERE action = 'team.password_recovery.config'")
      .get() as { n: number };
    expect(trilha.n).toBe(1);
  });

  it('com a operação ligada, "disponível" depende do SMTP estar pronto', async () => {
    await ligarNa(lojaA);
    expect(recuperacaoDisponivel(false)).toBe(false);
    expect(recuperacaoDisponivel(true)).toBe(true);
  });
});
