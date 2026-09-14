/**
 * ============================================================================
 * RODADA 31: DECLARAR O ALCANCE NÃO PODE MUDAR NENHUM ALCANCE
 * ============================================================================
 *
 * A rodada alargou a regra de lint `rota-declara-alcance` para os dezenove
 * roteadores de `src/routes/v1`. A varredura encontrou 67 rotas caladas — e o
 * conserto de cada uma foi DECLARAÇÃO, não mudança de comportamento: ou
 * `rotaPublica('motivo')` (um no-op que documenta a decisão de estar aberta),
 * ou, num único caso, a troca de um guarda escrito à mão pelo
 * `requirePermission` equivalente.
 *
 * Este arquivo é a prova por rota de que nada mudou de alcance:
 *
 * 1. `POST /auth/device/enroll` — o ÚNICO lugar onde código de guarda foi
 *    trocado. Antes: `if` de perfis dentro do handler (`admin_geral` ou
 *    `gestor`). Depois: `requirePermission('api.device.enroll')`, cujo módulo
 *    `api` é `{ler: [], escrever: []}` em `Permissions.ts` — lista vazia
 *    libera só quem responde por tudo, exatamente `admin_geral` e `gestor`.
 *    Mesmo conjunto, uma fonte de verdade. Os três casos aqui provam: o
 *    mecânico leva 403, o gestor atravessa o guarda (400 de payload, como
 *    antes), e o gestor com corpo válido registra o terminal (201).
 *
 * 2. As três rotas de sessão (`/logout`, `/session`, `/switch-company`)
 *    continuam abertas a QUALQUER perfil autenticado — a declaração
 *    `rotaPublica` nelas diz "sem permissão de propósito", e o teste usa o
 *    perfil mais raso (mecânico) para provar que a declaração não estreitou
 *    nada: se alguém um dia trocar a declaração por uma permissão, o mecânico
 *    não desloga mais e este arquivo fica vermelho.
 *
 * 3. `rotaPublica` é um no-op de verdade: as rotas públicas respondem sem
 *    token igual respondiam antes.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { resetDbForTests } from '../src/db/database.js';
import { linkUserToCompany, upsertCompany } from '../src/services/auth/IdentityService.js';
import { loginForTest } from './helpers/auth.js';

const app = createApp();
const EMPRESA = 'preco-justo';

beforeEach(() => {
  resetDbForTests();
});

describe('POST /auth/device/enroll: o guarda virou requirePermission sem mudar o conjunto', () => {
  it('o mecânico continua barrado — 403, o mesmo de antes', async () => {
    const login = await loginForTest(app, {
      userId: 'mec-1',
      companyId: EMPRESA,
      profileCodes: ['mecanico'],
    });
    const res = await request(app)
      .post('/api/v1/auth/device/enroll')
      .set('Authorization', `Bearer ${login.body.accessToken}`)
      .send({ userId: login.body.user.id, label: 'Bancada 1' });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('API_PERMISSION_DENIED');
  });

  it('o gestor atravessa o guarda: corpo sem userId leva o MESMO 400 de antes', async () => {
    /*
      O 400 é a prova de que o guarda deixou passar: `API_INVALID_PAYLOAD` só
      nasce DEPOIS do `requirePermission`. Se a permissão nova fosse mais
      estreita que o `if` antigo, este caso viraria 403 e ficaria vermelho.
    */
    const login = await loginForTest(app, {
      userId: 'gestor-1',
      companyId: EMPRESA,
      profileCodes: ['gestor'],
    });
    const res = await request(app)
      .post('/api/v1/auth/device/enroll')
      .set('Authorization', `Bearer ${login.body.accessToken}`)
      .send({ label: 'Terminal sem alvo' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('API_INVALID_PAYLOAD');
  });

  it('o gestor registra o terminal — 201 com o token em claro, como antes', async () => {
    const login = await loginForTest(app, {
      userId: 'gestor-1',
      companyId: EMPRESA,
      profileCodes: ['gestor'],
    });
    const res = await request(app)
      .post('/api/v1/auth/device/enroll')
      .set('Authorization', `Bearer ${login.body.accessToken}`)
      .send({ userId: login.body.user.id, label: 'PDV Balcão' });
    expect(res.status).toBe(201);
    expect(typeof res.body.deviceToken).toBe('string');
    expect(res.body.deviceToken.length).toBeGreaterThan(0);
  });
});

describe('as rotas de sessão continuam abertas a qualquer perfil autenticado', () => {
  /*
    O perfil escolhido é o mecânico DE PROPÓSITO: é o mais distante da gestão.
    Se `rotaPublica` nessas rotas for um dia trocado por uma permissão de
    módulo, é ele quem perde o logout primeiro — e este teste antes.
  */
  it('o mecânico consulta a própria sessão — 200', async () => {
    const login = await loginForTest(app, {
      userId: 'mec-1',
      companyId: EMPRESA,
      profileCodes: ['mecanico'],
    });
    const res = await request(app)
      .get('/api/v1/auth/session')
      .set('Authorization', `Bearer ${login.body.accessToken}`);
    expect(res.status).toBe(200);
    expect(res.body.session.companyId).toBe(EMPRESA);
  });

  it('o mecânico troca para uma empresa DO PRÓPRIO vínculo — 200', async () => {
    const login = await loginForTest(app, {
      userId: 'mec-1',
      companyId: EMPRESA,
      profileCodes: ['mecanico'],
    });
    /*
      A segunda operação do vínculo: trocar para a operação em que já se está
      deixou de ser troca (R2-SESSAO — 409, nada emitido). E a troca leva a
      prova da sessão, o refresh atual.
    */
    const OUTRA = 'oficina-do-mecanico';
    upsertCompany({ id: OUTRA, slug: OUTRA, legalName: `${OUTRA} Ltda`, tradeName: OUTRA });
    linkUserToCompany(String(login.body.user.id), OUTRA, 'mecanico', false);
    const res = await request(app)
      .post('/api/v1/auth/switch-company')
      .set('Authorization', `Bearer ${login.body.accessToken}`)
      .send({ companyId: OUTRA, refreshToken: login.body.refreshToken });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(typeof res.body.accessToken).toBe('string');
  });

  it('o mecânico encerra a própria sessão — 204', async () => {
    const login = await loginForTest(app, {
      userId: 'mec-1',
      companyId: EMPRESA,
      profileCodes: ['mecanico'],
    });
    const res = await request(app)
      .post('/api/v1/auth/logout')
      .set('Authorization', `Bearer ${login.body.accessToken}`)
      .send({ refreshToken: login.body.refreshToken });
    expect(res.status).toBe(204);
  });
});

describe('rotaPublica é no-op: o que era público segue respondendo sem token', () => {
  it('GET /api/v1/health — 200 sem Authorization', async () => {
    const res = await request(app).get('/api/v1/health');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
  });

  /*
    Aqui havia `GET /api/v1/storefronts/health`. A rodada 36 apagou a loja
    fantasma (PLURAL) inteira — rota, montagem e teste. O caso não foi movido
    porque não havia para onde: `/loja` (SINGULAR) não expõe sonda de saúde
    própria, e a sonda geral `/api/v1/health` já está coberta logo acima.
  */
  it('GET /api/v1/loja/stores — a vitrine responde sem sessão', async () => {
    const res = await request(app).get('/api/v1/loja/stores');
    expect(res.status).toBe(200);
  });
});
