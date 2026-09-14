process.env.TZ = 'UTC';
process.env.DEVORA_API_ENV = 'test';

/**
 * ============================================================================
 * AUDITORIA — FASE 2: AUTENTICAÇÃO
 * ============================================================================
 *
 * O que este arquivo prova, pela ROTA e com credencial de verdade:
 *
 *  1. LOGOUT REVOGA: o refresh entregue no login morre no logout. Sem isso,
 *     "sair" seria só esconder a tela — o refresh continuaria trocável por
 *     sessão nova por 7 dias. O teste existente (rodada-31) só cobrava o 204;
 *     ninguém provava que o token de fato morre.
 *  2. SESSÃO EXPIRADA É 401: o access token tem 1 hora. Adiantando SÓ o
 *     relógio (Date falso, timers de socket reais) para além do vencimento, a
 *     rota autenticada recusa. Nenhum teste existente media a expiração.
 *  3. SENHA ERRADA NÃO É ORÁCULO: login existente com senha errada e login
 *     que nunca existiu respondem com o MESMO status, código e mensagem.
 *     core-api.test.ts cobria só a metade do usuário existente.
 *  4. O ACERTO ANTES DO TETO ZERA: 4 erros + acerto + 4 erros não trancam.
 *     Se a contagem acumulasse, o segundo acerto levaria 429 — são 8 falhas
 *     do mesmo par (login + origem), acima do teto de 5.
 *  5. PRIMEIRO ACESSO COM SENHA PROVISÓRIA: `must_change_password = 1` é
 *     gravado na criação e regravado no reset da gestão — e agora o LOGIN
 *     devolve a bandeira no corpo (o caso aqui nasceu VERMELHO como prova RED
 *     do defeito e ficou verde com o conserto). A saída do beco é a rota de
 *     autosserviço `POST /auth/password`, que confere a senha atual, limpa a
 *     bandeira e derruba as sessões antigas — coberta caso a caso em
 *     senha-propria-e-terminal-revogavel.test.ts. O par verde daqui documenta
 *     o que NÃO mudou: a rota da gestão continua recusando o próprio alvo.
 *  6. PDV POR TOKEN DE TERMINAL: registro + login de terminal funcionam, e o
 *     guarda honra `revoked = 1` e `expires_at` quando estão no banco. A
 *     alavanca prometida pelo cabeçalho de auth.ts existe hoje —
 *     `POST /auth/device/:id/revoke` e `GET /auth/devices`, cobertas em
 *     senha-propria-e-terminal-revogavel.test.ts; aqui se prova que o guarda
 *     honra a coluna, seja quem for que a marque.
 *
 * O que JÁ É COBERTO por teste comportamental existente — e NÃO se repete:
 *  - login normal devolve token+perfil .......... regressions.test.ts ("o PDV
 *    entra com usuário e senha") e core-api.test.ts ("autenticação");
 *  - rotação de refresh (o usado morre) ......... sessao-do-desligado.test.ts
 *    ("o caminho feliz fica de pé, com rotação");
 *  - lockout: 5 falhas do mesmo par → 429 ....... bloqueio-de-login-nao-e-arma
 *    .test.ts e core-api.test.ts ("bloqueia após tentativas repetidas");
 *  - troca de senha derruba sessões antigas ..... sessao-do-desligado.test.ts
 *    ("trocar a senha derruba as sessões anteriores — session_version ganhou
 *    o leitor");
 *  - usuário desativado não loga ................ contador-acesso.test.ts
 *    ("depois de desligado, ele não entra mais — o login é recusado");
 *  - o refresh do desativado morre e não volta .. sessao-do-desligado.test.ts
 *    ("desativar a conta mata a renovação" e "reativar a conta NÃO
 *    ressuscita o refresh");
 *  - troca de empresa só com vínculo ............ adm-preso-a-sua-loja.test.ts
 *    ("a troca de loja continua barrada pelo vínculo");
 *  - operador não alcança rota de gestão (403) e a gestão alcança
 *    ............................................. rodada-31-alcance-declarado
 *    .test.ts (mecânico 403 / gestor 201 no device/enroll) e
 *    sessao-do-desligado.test.ts (atendente 403 na prévia do fechamento);
 *  - nenhuma entrada sem senha existe .......... acesso-sem-senha-em-ambiente-
 *    nenhum.test.ts (4 ambientes × 2 NODE_ENV × 3 variáveis: 404 de toda
 *    origem, ou o boot recusa em produção), regressions.test.ts, quick-login-
 *    so-da-propria-maquina.test.ts (nem o loopback entra); a variável
 *    aposentada no boot: quick-login-dev.test.ts e producao-nao-entra-sem-
 *    senha.test.ts; o código não a traz de volta: acesso-sem-senha-nao-
 *    volta.test.ts.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
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

describe('logout revoga o refresh', () => {
  it('depois do logout, o refresh do login não troca mais por sessão nova', async () => {
    const caixa = await entrar('CAIXA.QUE.SAI', 'operador_caixa_loja');

    const saiu = await request(app)
      .post('/api/v1/auth/logout')
      .set(caixa.auth)
      .send({ refreshToken: caixa.refreshToken });
    expect(saiu.status).toBe(204);

    // O 204 sozinho não prova nada — a prova é o refresh estar MORTO.
    const renovar = await request(app)
      .post('/api/v1/auth/refresh')
      .send({ refreshToken: caixa.refreshToken });
    expect(renovar.status, JSON.stringify(renovar.body)).toBe(401);
    expect(renovar.body.accessToken).toBeUndefined();
  });
});

describe('a sessão expirada responde 401', () => {
  it('o access token vence em 1 hora — vencido, a rota autenticada recusa', async () => {
    const caixa = await entrar('CAIXA.DO.RELOGIO', 'operador_caixa_loja');

    const antes = await request(app).get('/api/v1/auth/session').set(caixa.auth);
    expect(antes.status).toBe(200);

    /*
      Só o RELÓGIO anda — 1 hora e 1 minuto, além do TTL de 3600s. `toFake`
      restrito a Date de propósito: falsificar setTimeout congelaria o socket
      do supertest, e o que se quer vencer é o `exp` do JWT, que o jwt.verify
      compara com Date.now().
    */
    vi.useFakeTimers({ toFake: ['Date'], now: Date.now() + 3_660_000 });
    try {
      const depois = await request(app).get('/api/v1/auth/session').set(caixa.auth);
      expect(depois.status, JSON.stringify(depois.body)).toBe(401);
      expect(depois.body.error.code).toBe('API_INVALID_TOKEN');
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('senha errada não conta se o login existe', () => {
  it('login existente com senha errada e login inexistente respondem IGUAL', async () => {
    const existenteId = await upsertUser({
      login: 'EXISTE.NA.CASA',
      displayName: 'Existe',
      password: SENHA,
    });
    linkUserToCompany(existenteId, loja, 'gerente_loja', true);

    const existente = await request(app)
      .post('/api/v1/auth/login')
      .send({ login: 'EXISTE.NA.CASA', password: 'senha-errada' });
    const fantasma = await request(app)
      .post('/api/v1/auth/login')
      .send({ login: 'NUNCA.EXISTIU', password: 'senha-errada' });

    expect(existente.status).toBe(401);
    expect(fantasma.status).toBe(401);
    // Mesmo código E mesma mensagem: qualquer diferença viraria uma sonda
    // gratuita de "quais logins existem" para quem varre a tela de login.
    expect(existente.body.error.code).toBe('API_INVALID_CREDENTIALS');
    expect(fantasma.body.error).toEqual(existente.body.error);
  });
});

describe('o acerto antes do teto zera a contagem de falhas', () => {
  it('4 erros, acerto, mais 4 erros: a conta não tranca', async () => {
    await entrar('GERENTE.TEIMOSO', 'gerente_loja');
    const errar = () =>
      request(app)
        .post('/api/v1/auth/login')
        .send({ login: 'GERENTE.TEIMOSO', password: 'errada' });
    const acertar = () =>
      request(app)
        .post('/api/v1/auth/login')
        .send({ login: 'GERENTE.TEIMOSO', password: SENHA, companyId: loja });

    for (let i = 0; i < 4; i += 1) expect((await errar()).status).toBe(401);

    const primeiro = await acertar();
    expect(primeiro.status, JSON.stringify(primeiro.body)).toBe(200);

    for (let i = 0; i < 4; i += 1) expect((await errar()).status).toBe(401);

    /*
      Se o acerto não zerasse, aqui já seriam 8 falhas do MESMO par
      (login + origem do supertest), acima do teto de 5 — e este login correto
      levaria 429 em vez de entrar.
    */
    const segundo = await acertar();
    expect(segundo.status, JSON.stringify(segundo.body)).toBe(200);
    expect(segundo.body.accessToken).toBeTruthy();
  });
});

describe('primeiro acesso com senha provisória (must_change_password)', () => {
  const PROVISORIA = 'Provisoria@2026';

  /** O caminho real da tela de equipe: a gestora cadastra e entrega a senha. */
  async function novatoCriadoPelaGestora() {
    const gestora = await entrar('GESTORA.EQUIPE', 'gestor');
    const criado = await request(app)
      .post('/api/v1/core/team')
      .set(gestora.auth)
      .send({
        login: 'NOVATO.PDV',
        displayName: 'Novato do PDV',
        profileCode: 'operador_caixa_loja',
        password: PROVISORIA,
      });
    expect(criado.status, JSON.stringify(criado.body)).toBe(201);
    // A bandeira é GRAVADA — esta metade team.test.ts já cobre; aqui é cenário.
    expect(criado.body.mustChangePassword).toBe(true);
    return { novatoId: String(criado.body.id) };
  }

  it('o login AVISA que a senha é provisória — a bandeira atravessa o corpo', async () => {
    await novatoCriadoPelaGestora();

    const primeiro = await request(app)
      .post('/api/v1/auth/login')
      .send({ login: 'NOVATO.PDV', password: PROVISORIA, companyId: loja });

    // O login continua completo: token de verdade, dá para vender no mesmo minuto.
    expect(primeiro.status, JSON.stringify(primeiro.body)).toBe(200);
    expect(primeiro.body.accessToken).toBeTruthy();

    /*
      Este caso nasceu VERMELHO DE PROPÓSITO — a prova RED do defeito: a
      bandeira não atravessava o login, e a tela não tinha COMO pedir a troca,
      porque o dado "senha provisória" só saía em /core/team, que o novato não
      alcança. Hoje o corpo do login a devolve; quem a LIMPA é o autosserviço
      POST /auth/password (senha atual conferida, must_change_password = 0,
      sessões antigas derrubadas), cobrado caso a caso em
      senha-propria-e-terminal-revogavel.test.ts.
    */
    expect(primeiro.body.user.mustChangePassword).toBe(true);
  });

  it('a rota da GESTÃO continua recusando o próprio alvo — o autosserviço é outra porta', async () => {
    const { novatoId } = await novatoCriadoPelaGestora();

    const primeiro = await request(app)
      .post('/api/v1/auth/login')
      .send({ login: 'NOVATO.PDV', password: PROVISORIA, companyId: loja });
    expect(primeiro.status).toBe(200);

    /*
      POST /core/team/:id/password segue atrás de requireProfile(gerente_loja,
      gerente_oficina), e o próprio alvo segue levando 403 mesmo mirando a si
      mesmo — o conserto NÃO alargou a porta da gestão. O caminho do dono é
      POST /auth/password (sessão própria + senha atual), coberto em
      senha-propria-e-terminal-revogavel.test.ts; este verde prova que a porta
      antiga não mudou de alcance.
    */
    const tentativa = await request(app)
      .post(`/api/v1/core/team/${novatoId}/password`)
      .set({ Authorization: `Bearer ${primeiro.body.accessToken}` })
      .send({ password: 'MinhaNova@2026' });
    expect(tentativa.status, JSON.stringify(tentativa.body)).toBe(403);
  });
});

describe('PDV por token de terminal', () => {
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
    return { deviceToken: String(enroll.body.deviceToken), pdvId };
  }

  it('o terminal registrado entra sem senha — e o token REVOGADO morre no login seguinte', async () => {
    const { deviceToken } = await terminalRegistrado();

    const entrada = await request(app)
      .post('/api/v1/auth/device/login')
      .send({ deviceToken });
    expect(entrada.status, JSON.stringify(entrada.body)).toBe(200);
    expect(entrada.body.accessToken).toBeTruthy();
    expect(entrada.body.company.id).toBe(loja);
    expect(entrada.body.user.profileCode).toBe('operador_caixa_loja');

    /*
      A revogação aqui é por SQL DE PROPÓSITO, mesmo já existindo a rota
      (POST /auth/device/:id/revoke, coberta de ponta a ponta em
      senha-propria-e-terminal-revogavel.test.ts): o que se prova neste caso é
      que o guarda do login honra a COLUNA, seja quem for que a marque.
    */
    getConnection().prepare('UPDATE core_device_tokens SET revoked = 1').run();

    const revogado = await request(app)
      .post('/api/v1/auth/device/login')
      .send({ deviceToken });
    expect(revogado.status, JSON.stringify(revogado.body)).toBe(401);
    expect(revogado.body.accessToken).toBeUndefined();
  });

  it('token de terminal com validade vencida também é recusado — o guarda lê expires_at', async () => {
    const { deviceToken } = await terminalRegistrado();
    // Nenhuma rota grava expires_at (o enroll insere sem a coluna → NULL,
    // token eterno); marcada no banco, a validade é honrada.
    getConnection()
      .prepare('UPDATE core_device_tokens SET expires_at = ?')
      .run(new Date(Date.now() - 60_000).toISOString());

    const vencido = await request(app)
      .post('/api/v1/auth/device/login')
      .send({ deviceToken });
    expect(vencido.status, JSON.stringify(vencido.body)).toBe(401);
  });

  it('token inventado não entra — 401, sem oráculo de existência', async () => {
    await terminalRegistrado();
    const chute = await request(app)
      .post('/api/v1/auth/device/login')
      .send({ deviceToken: 'token-chutado-qualquer' });
    expect(chute.status).toBe(401);
    expect(chute.body.error.code).toBe('API_INVALID_TOKEN');
  });
});
