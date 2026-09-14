process.env.TZ = 'UTC';
process.env.DEVORA_API_ENV = 'test';

/**
 * ============================================================================
 * CONSERTOS DA AUDITORIA — AUTENTICAÇÃO: AS TRÊS PONTAS QUE FALTAVAM
 * ============================================================================
 *
 * Este arquivo nasceu VERMELHO de propósito, antes do conserto — é a prova RED
 * dos três defeitos que a fase 2 da auditoria mediu:
 *
 *  1. SENHA PROVISÓRIA ERA BECO SEM SAÍDA: `must_change_password = 1` era
 *     gravado na criação e no reset, e NINGUÉM jamais gravava 0 — o dono da
 *     conta não tinha rota para trocar a própria senha, e a que a gestão usa
 *     (`POST /core/team/:id/password`) regrava 1. O conserto é a rota
 *     `POST /auth/password`: sessão própria, senha atual como credencial,
 *     régua mínima igual à da gestão, Argon2id, limpa a bandeira e sobe
 *     `session_version`. A metade do login (a bandeira atravessar o corpo)
 *     tem o RED dela em audit-auth.test.ts; aqui ela aparece como consequência.
 *
 *  2. E-MAIL REPETIA NA EQUIPE: só o login tinha dedupe. Dois crachás com o
 *     mesmo endereço é a duplicata que explode no dia em que notificação ou
 *     recuperação de senha passar a usar o campo. O RED do caso simples está
 *     em audit-manager.test.ts ("e-mail já usado por outro membro NÃO deveria
 *     repetir — e repete") e fica verde com este conserto; aqui apertam-se as
 *     pontas que aquele caso não cobre: caixa diferente (COLLATE NOCASE) e o
 *     PATCH — inclusive o falso positivo de resalvar o próprio e-mail.
 *
 *  3. TOKEN DE TERMINAL ERA IRREVOGÁVEL: o cabeçalho de `device/login` promete
 *     "revogável a qualquer momento" e a promessa só se cumpria com SQL na
 *     mão. O conserto são duas rotas de gestão (mesmo alcance do enroll:
 *     módulo `api`, só quem responde pelo grupo): `GET /auth/devices` lista os
 *     terminais da empresa com `last_used_at` e SEM expor token, e
 *     `POST /auth/device/:id/revoke` corta o terminal.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import { createApp } from '../src/app.js';
import { getConnection } from '../src/db/sqlite.js';
import { resetDbForTests } from '../src/db/database.js';
import {
  linkUserToCompany,
  upsertCompany,
  upsertUser,
} from '../src/services/auth/IdentityService.js';

const app = createApp();
const SENHA = 'Auditoria@Fase2.2026';
const PROVISORIA = 'Provisoria@2026';

let loja: string;

beforeEach(() => {
  resetDbForTests();
  loja = upsertCompany({
    slug: 'preco-justo',
    legalName: 'Preço Justo Comércio Ltda',
    tradeName: 'Preço Justo',
    kind: 'retail',
  });
});

/** Usuário real com vínculo na loja, logado com senha Argon2id — nada de token forjado. */
async function entrar(login: string, perfil: string) {
  const userId = await upsertUser({ login, displayName: login, password: SENHA });
  linkUserToCompany(userId, loja, perfil, true);
  const res = await request(app)
    .post('/api/v1/auth/login')
    .send({ login, password: SENHA, companyId: loja });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return {
    userId,
    accessToken: String(res.body.accessToken),
    refreshToken: String(res.body.refreshToken),
    auth: { Authorization: `Bearer ${res.body.accessToken}` },
  };
}

/** O caminho real da tela de equipe: a gestora cadastra e entrega a senha provisória. */
async function criadoPelaGestora(corpo: Record<string, unknown>) {
  const gestora = await entrar('GESTORA.EQUIPE', 'gestor');
  const criado = await request(app)
    .post('/api/v1/core/team')
    .set(gestora.auth)
    .send({ profileCode: 'operador_caixa_loja', password: PROVISORIA, ...corpo });
  return { gestora, criado };
}

/** A bandeira DIRETO do banco — a prova que nenhum corpo de resposta substitui. */
function bandeiraNoBanco(userId: string): number {
  const row = getConnection()
    .prepare('SELECT must_change_password AS flag FROM core_users WHERE id = ?')
    .get(userId) as { flag?: number } | undefined;
  return row?.flag ?? -1;
}

describe('POST /auth/password — o dono da conta troca a própria senha', () => {
  it('sem sessão não existe troca — 401 na porta', async () => {
    const res = await request(app)
      .post('/api/v1/auth/password')
      .send({ currentPassword: PROVISORIA, newPassword: 'MinhaNova@2026' });
    expect(res.status, JSON.stringify(res.body)).toBe(401);
  });

  it('senha atual errada é recusada com 401 — e nem a bandeira nem a sessão mudam', async () => {
    const { criado } = await criadoPelaGestora({ login: 'NOVATO.PDV', displayName: 'Novato do PDV' });
    expect(criado.status, JSON.stringify(criado.body)).toBe(201);

    const primeiro = await request(app)
      .post('/api/v1/auth/login')
      .send({ login: 'NOVATO.PDV', password: PROVISORIA, companyId: loja });
    expect(primeiro.status).toBe(200);

    const tentativa = await request(app)
      .post('/api/v1/auth/password')
      .set({ Authorization: `Bearer ${primeiro.body.accessToken}` })
      .send({ currentPassword: 'Chutada@Errada1', newPassword: 'MinhaNova@2026' });
    expect(tentativa.status, JSON.stringify(tentativa.body)).toBe(401);

    // Nada mudou: a bandeira segue de pé e o refresh emitido antes segue vivo —
    // uma tentativa errada não pode derrubar as sessões de quem errou.
    expect(bandeiraNoBanco(String(criado.body.id))).toBe(1);
    const renovar = await request(app)
      .post('/api/v1/auth/refresh')
      .send({ refreshToken: primeiro.body.refreshToken });
    expect(renovar.status, JSON.stringify(renovar.body)).toBe(200);
  });

  it('senha nova curta é recusada com 400 — a régua é a MESMA da senha provisória da gestão', async () => {
    const { criado } = await criadoPelaGestora({ login: 'NOVATO.PDV', displayName: 'Novato do PDV' });
    expect(criado.status).toBe(201);

    const primeiro = await request(app)
      .post('/api/v1/auth/login')
      .send({ login: 'NOVATO.PDV', password: PROVISORIA, companyId: loja });
    expect(primeiro.status).toBe(200);

    const curta = await request(app)
      .post('/api/v1/auth/password')
      .set({ Authorization: `Bearer ${primeiro.body.accessToken}` })
      .send({ currentPassword: PROVISORIA, newPassword: 'Curta@1' });
    expect(curta.status, JSON.stringify(curta.body)).toBe(400);
    expect(curta.body.error.code).toBe('CORE_PASSWORD_WEAK');
    expect(bandeiraNoBanco(String(criado.body.id))).toBe(1);
  });

  it('a troca limpa a bandeira no banco, derruba as sessões antigas e aposenta a senha velha', async () => {
    const { criado } = await criadoPelaGestora({ login: 'NOVATO.PDV', displayName: 'Novato do PDV' });
    expect(criado.status).toBe(201);
    const novatoId = String(criado.body.id);

    // Duas sessões abertas com a provisória: o balcão e o celular do novato.
    const balcao = await request(app)
      .post('/api/v1/auth/login')
      .send({ login: 'NOVATO.PDV', password: PROVISORIA, companyId: loja });
    const celular = await request(app)
      .post('/api/v1/auth/login')
      .send({ login: 'NOVATO.PDV', password: PROVISORIA, companyId: loja });
    expect(balcao.status).toBe(200);
    expect(celular.status).toBe(200);

    const troca = await request(app)
      .post('/api/v1/auth/password')
      .set({ Authorization: `Bearer ${balcao.body.accessToken}` })
      .send({ currentPassword: PROVISORIA, newPassword: 'MinhaNova@2026' });
    expect(troca.status, JSON.stringify(troca.body)).toBe(204);

    // A bandeira foi LIMPA — o primeiro escritor de must_change_password = 0.
    expect(bandeiraNoBanco(novatoId)).toBe(0);

    /*
      session_version subiu, igual ao reset da gestão: TODOS os refresh
      anteriores morrem — inclusive o da própria sessão que pediu a troca.
      É o preço documentado na rota: quem trocou entra de novo com a senha
      nova, e quem estava logado com a provisória (a gestora sabia qual era)
      cai junto.
    */
    const balcaoRenova = await request(app)
      .post('/api/v1/auth/refresh')
      .send({ refreshToken: balcao.body.refreshToken });
    const celularRenova = await request(app)
      .post('/api/v1/auth/refresh')
      .send({ refreshToken: celular.body.refreshToken });
    expect(balcaoRenova.status, JSON.stringify(balcaoRenova.body)).toBe(401);
    expect(celularRenova.status, JSON.stringify(celularRenova.body)).toBe(401);

    /*
      E o ACCESS já emitido também cai, na requisição seguinte (GAP-PRD-053).
      Aqui morava a "janela de 1 hora": o access valia até expirar e só a
      renovação morria. Agora `authMiddleware` confere a `session_version`
      da conta a cada requisição — as duas sessões da provisória caem na hora.
    */
    for (const sessao of [balcao, celular]) {
      const depois = await request(app)
        .get('/api/v1/auth/session')
        .set({ Authorization: `Bearer ${sessao.body.accessToken}` });
      expect(depois.status).toBe(401);
      expect(depois.body.error.code).toBe('API_SESSION_ENDED');
    }

    // A senha velha aposentou; a nova entra — e entra já sem a bandeira.
    const velha = await request(app)
      .post('/api/v1/auth/login')
      .send({ login: 'NOVATO.PDV', password: PROVISORIA, companyId: loja });
    expect(velha.status).toBe(401);

    const nova = await request(app)
      .post('/api/v1/auth/login')
      .send({ login: 'NOVATO.PDV', password: 'MinhaNova@2026', companyId: loja });
    expect(nova.status, JSON.stringify(nova.body)).toBe(200);
    expect(nova.body.user.mustChangePassword).toBe(false);
  });
});

describe('e-mail não repete na equipe — COLLATE NOCASE, 409 nomeado', () => {
  it('segundo membro com o mesmo e-mail em OUTRA caixa é recusado — 409 CORE_EMAIL_TAKEN', async () => {
    /*
      O RED do caso simples (mesma caixa) é do vizinho, em audit-manager
      .test.ts — e fica verde com este mesmo conserto. Aqui aperta-se o que
      aquele caso não cobre: e-mail é identidade sem caixa, como o login.
    */
    const { gestora, criado } = await criadoPelaGestora({
      login: 'ANA.BALCAO',
      displayName: 'Ana do Balcão',
      email: 'ana@precojusto.com.br',
    });
    expect(criado.status, JSON.stringify(criado.body)).toBe(201);

    const repetido = await request(app)
      .post('/api/v1/core/team')
      .set(gestora.auth)
      .send({
        login: 'ANA.IMPOSTORA',
        displayName: 'Outra Ana',
        profileCode: 'operador_caixa_loja',
        password: PROVISORIA,
        email: 'ANA@PRECOJUSTO.COM.BR',
      });
    expect(repetido.status, JSON.stringify(repetido.body)).toBe(409);
    expect(repetido.body.error.code).toBe('CORE_EMAIL_TAKEN');
  });

  it('o PATCH não rouba o e-mail de outro membro — e resalvar o PRÓPRIO não é 409', async () => {
    const { gestora, criado } = await criadoPelaGestora({
      login: 'ANA.BALCAO',
      displayName: 'Ana do Balcão',
      email: 'ana@precojusto.com.br',
    });
    expect(criado.status).toBe(201);

    const bia = await request(app)
      .post('/api/v1/core/team')
      .set(gestora.auth)
      .send({
        login: 'BIA.ESTOQUE',
        displayName: 'Bia do Estoque',
        profileCode: 'estoquista',
        password: PROVISORIA,
        email: 'bia@precojusto.com.br',
      });
    expect(bia.status, JSON.stringify(bia.body)).toBe(201);

    // Tomar o endereço da Ana pelo PATCH — mesma recusa da criação.
    const rouba = await request(app)
      .patch(`/api/v1/core/team/${bia.body.id}`)
      .set(gestora.auth)
      .send({ email: 'Ana@PrecoJusto.com.br' });
    expect(rouba.status, JSON.stringify(rouba.body)).toBe(409);
    expect(rouba.body.error.code).toBe('CORE_EMAIL_TAKEN');

    // Resalvar o próprio e-mail não pode ser recusado: é o PATCH mais comum
    // da tela (mudou o nome, o e-mail veio junto no corpo, intacto).
    const resalva = await request(app)
      .patch(`/api/v1/core/team/${bia.body.id}`)
      .set(gestora.auth)
      .send({ displayName: 'Bia do Estoque Central', email: 'bia@precojusto.com.br' });
    expect(resalva.status, JSON.stringify(resalva.body)).toBe(200);
    expect(resalva.body.email).toBe('bia@precojusto.com.br');
  });
});

describe('terminal de PDV revogável pela ROTA — a promessa do cabeçalho se cumpre', () => {
  /** Registro real: a gestora cadastra o token para o usuário do balcão. */
  async function terminalRegistrado() {
    const gestora = await entrar('GESTORA.PDV', 'gestor');
    const pdvId = await upsertUser({
      login: 'PDV.BALCAO',
      displayName: 'PDV Balcão',
      password: SENHA,
    });
    linkUserToCompany(pdvId, loja, 'operador_caixa_loja', false);

    const enroll = await request(app)
      .post('/api/v1/auth/device/enroll')
      .set(gestora.auth)
      .send({ userId: pdvId, label: 'PDV Balcão 1' });
    expect(enroll.status, JSON.stringify(enroll.body)).toBe(201);
    return { gestora, deviceToken: String(enroll.body.deviceToken), pdvId };
  }

  it('GET /auth/devices lista os terminais da empresa com last_used_at — e NUNCA o token', async () => {
    const { gestora, deviceToken } = await terminalRegistrado();

    // Um login de terminal para o last_used_at ter o que contar.
    const entrada = await request(app)
      .post('/api/v1/auth/device/login')
      .send({ deviceToken });
    expect(entrada.status, JSON.stringify(entrada.body)).toBe(200);

    const lista = await request(app).get('/api/v1/auth/devices').set(gestora.auth);
    expect(lista.status, JSON.stringify(lista.body)).toBe(200);
    expect(lista.body.items).toHaveLength(1);

    const item = lista.body.items[0];
    expect(item.label).toBe('PDV Balcão 1');
    expect(item.revoked).toBe(false);
    expect(item.lastUsedAt).toBeTruthy();

    // O token só existiu em claro na resposta do enroll; nem ele nem o hash
    // podem vazar pela listagem — a lista é para AUDITAR, não para copiar.
    const corpo = JSON.stringify(lista.body);
    expect(corpo).not.toContain(deviceToken);
    expect(corpo.toLowerCase()).not.toContain('token_hash');
    expect(corpo.toLowerCase()).not.toContain('tokenhash');
  });

  it('POST /auth/device/:id/revoke corta o terminal — o login seguinte morre', async () => {
    const { gestora, deviceToken } = await terminalRegistrado();

    const antes = await request(app)
      .post('/api/v1/auth/device/login')
      .send({ deviceToken });
    expect(antes.status).toBe(200);

    const lista = await request(app).get('/api/v1/auth/devices').set(gestora.auth);
    const id = String(lista.body.items[0].id);

    const revoga = await request(app)
      .post(`/api/v1/auth/device/${id}/revoke`)
      .set(gestora.auth)
      .send({});
    expect(revoga.status, JSON.stringify(revoga.body)).toBe(200);
    expect(revoga.body.revoked).toBe(true);

    // A alavanca funciona de ponta a ponta: o mesmo token que entrava, morre.
    const depois = await request(app)
      .post('/api/v1/auth/device/login')
      .send({ deviceToken });
    expect(depois.status, JSON.stringify(depois.body)).toBe(401);

    // E a listagem conta a história: o terminal aparece como revogado.
    const relida = await request(app).get('/api/v1/auth/devices').set(gestora.auth);
    expect(relida.body.items[0].revoked).toBe(true);
  });

  it('quem não é da gestão não lista nem revoga — 403 nas duas portas', async () => {
    const { gestora } = await terminalRegistrado();
    const lista = await request(app).get('/api/v1/auth/devices').set(gestora.auth);
    const id = String(lista.body.items[0].id);

    const caixa = await entrar('CAIXA.CURIOSO', 'operador_caixa_loja');

    const listaNegada = await request(app).get('/api/v1/auth/devices').set(caixa.auth);
    expect(listaNegada.status).toBe(403);
    expect(listaNegada.body.error.code).toBe('API_PERMISSION_DENIED');

    const revogaNegada = await request(app)
      .post(`/api/v1/auth/device/${id}/revoke`)
      .set(caixa.auth)
      .send({});
    expect(revogaNegada.status).toBe(403);
    expect(revogaNegada.body.error.code).toBe('API_PERMISSION_DENIED');
  });

  it('revogar id que não existe nesta empresa é 404 nomeado — não 500, não silêncio', async () => {
    const { gestora } = await terminalRegistrado();
    const chute = await request(app)
      .post(`/api/v1/auth/device/${randomUUID()}/revoke`)
      .set(gestora.auth)
      .send({});
    expect(chute.status, JSON.stringify(chute.body)).toBe(404);
    expect(chute.body.error.code).toBe('API_DEVICE_NOT_FOUND');
  });
});
