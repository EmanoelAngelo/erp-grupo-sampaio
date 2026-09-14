/**
 * ============================================================================
 * UMA SONDA QUE SEMPRE DIZ SIM É PIOR QUE NENHUMA
 * ============================================================================
 *
 * `/readiness` existe e responde `ready: true` e `database: true` CRAVADOS no
 * código — não consulta nada. É a sonda que o orquestrador usa para decidir se
 * manda tráfego: com ela mentindo, um processo cujo banco não abre recebe a
 * fila da loja inteira e responde erro a cada requisição.
 *
 * A diferença entre as duas sondas é o que dá sentido às duas:
 *
 *   /health     o processo está VIVO — respondeu
 *   /readiness  o processo está APTO — as dependências para servir respondem
 *
 * ============================================================================
 * E O QUE ELA NÃO PODE DIZER
 * ============================================================================
 *
 * `/readiness` é rota pública, sem sessão — é assim que o orquestrador a
 * alcança antes de existir login. Então ela não pode contar o estado dos
 * segredos: "a senha do certificado está ausente" e "a chave de cifra é a
 * padrão" são exatamente o que alguém de fora gostaria de saber antes de
 * tentar.
 *
 * O diagnóstico dos segredos existe, e mora atrás de autenticação, para o dono
 * do sistema. Este arquivo cobra as duas coisas: que a sonda pública seja
 * verdadeira, e que ela seja MUDA sobre o cofre.
 *
 * ============================================================================
 * E A REGRA DO BLOQUEIO PARCIAL
 * ============================================================================
 *
 * Faltar CSC bloqueia a NFC-e. Não bloqueia o ERP: o balcão continua vendendo,
 * a oficina continua abrindo OS, a loja continua recebendo pedido. Uma sonda
 * que respondesse "não apto" por causa do CSC tiraria o sistema inteiro do ar
 * por causa de um documento fiscal que ainda espera um dado do portal da
 * SEFAZ.
 */
process.env.TZ = 'UTC';
process.env.DEVORA_API_ENV = 'test';
process.env.DEVORA_DATABASE_PATH = ':memory:';
process.env.DEVORA_JWT_SECRET = 'test-jwt-secret-suficientemente-longo';
process.env.DEVORA_ENCRYPTION_KEY = 'test-encryption-key-suficientemente-longa';

import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';

const { createApp } = await import('../src/app.js');
const { resetDbForTests } = await import('../src/db/database.js');
const { resetCoreSchemaCache } = await import('../src/db/schema.js');
const { loginForTest } = await import('./helpers/auth.js');

const app = createApp();

beforeEach(() => {
  /*
    O caso do banco derrubado APAGA uma tabela de propósito, e o esquema tem
    trava de módulo: sem soltar a trava aqui, os casos seguintes rodariam
    contra um banco mutilado e falhariam por contágio, não por defeito.
  */
  resetCoreSchemaCache();
  resetDbForTests();
});

// ============================================================================

describe('a sonda pública diz a verdade sobre o que pode', () => {
  it('/health responde que o processo está vivo', async () => {
    const res = await request(app).get('/api/v1/health');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
  });

  it('/readiness CONSULTA o banco em vez de afirmar que ele está de pé', async () => {
    const res = await request(app).get('/api/v1/readiness');

    expect(res.status).toBe(200);
    expect(res.body.ready).toBe(true);
    expect(res.body.database).toBe(true);
    /*
      O carimbo prova que a resposta foi PRODUZIDA agora. Um `true` constante
      passaria no caso acima sem consultar nada — foi assim que a sonda viveu
      até esta rodada.
    */
    expect(res.body.checkedAt).toBeTruthy();
  });

  it('e responde 503 quando o banco não responde', async () => {
    /*
      É o caso que dá sentido à sonda. Sem ele, "ready" é decoração: o
      orquestrador manda tráfego para um processo que não tem como atender.
    */
    const { closeConnection } = await import('../src/db/sqlite.js');
    const { getConnection } = await import('../src/db/sqlite.js');
    // Derruba a tabela que a sonda consulta, sem tocar em mais nada.
    getConnection().exec('DROP TABLE IF EXISTS core_companies');

    const res = await request(app).get('/api/v1/readiness');
    expect(res.status).toBe(503);
    expect(res.body.ready).toBe(false);
    expect(res.body.database).toBe(false);

    void closeConnection;
  });
});

// ============================================================================

describe('a sonda pública é MUDA sobre o cofre', () => {
  it('não conta o estado da chave de cifra nem dos segredos', async () => {
    const res = await request(app).get('/api/v1/readiness');
    const texto = JSON.stringify(res.body).toLowerCase();

    for (const proibido of [
      'encryption',
      'secret',
      'pfx',
      'certificad',
      'password',
      'senha',
      'csc',
      'token',
      'apikey',
      'api_key',
    ]) {
      expect(texto, `"${proibido}" não pode aparecer numa rota sem sessão`).not.toContain(proibido);
    }
  });
});

// ============================================================================

describe('o diagnóstico do cofre é do dono, e não do mundo', () => {
  it('sem sessão, é recusado', async () => {
    const res = await request(app).get('/api/v1/core/system/secrets-readiness');
    expect(res.status).toBe(401);
  });

  it('com gerente, é recusado — este é o diagnóstico do dono', async () => {
    const g = await loginForTest(app, {
      userId: 'ger-prontidao',
      companyId: 'loja-prontidao',
      profileCodes: ['gerente_loja'],
    });
    const res = await request(app)
      .get('/api/v1/core/system/secrets-readiness')
      .set({ Authorization: `Bearer ${g.body.accessToken}` });
    expect(res.status).toBe(403);
  });

  it('com o dono, responde o estado de cada segredo — e nenhum valor', async () => {
    const dono = await loginForTest(app, {
      userId: 'dono-prontidao',
      companyId: 'loja-prontidao',
      profileCodes: ['admin_geral'],
    });
    const res = await request(app)
      .get('/api/v1/core/system/secrets-readiness')
      .set({ Authorization: `Bearer ${dono.body.accessToken}` });

    expect(res.status).toBe(200);

    /*
      A FORMA MUDOU, E ESTE CASO É O TRIPWIRE QUE PEGOU.

      As quatro credenciais de PROVEDOR deixaram de ser um rótulo só e passaram
      a carregar dois fatos: o selo de hoje e se a credencial ainda precisa ser
      trocada no portal que a emitiu.

      A distinção não é cosmética. `SEALED_CURRENT_KEY` diz que o cofre está
      fechado com a chave certa AGORA — e não diz nada sobre ontem. Os cinco
      segredos desta instalação viveram selados com a chave padrão, que está
      escrita no repositório, enquanto cópias inteiras do banco saíam para o
      bucket remoto. Resselar troca a fechadura de uma porta cuja cópia da
      chave antiga já está na rua.

      O `.pfx` continua com rótulo simples: ele é inútil sem a senha, que nunca
      esteve no banco. Uma chave de API não tem esse conforto — ela É a
      credencial.
    */
    expect(['PRODUCTION_SAFE', 'DEVELOPMENT_DEFAULT', 'MISSING']).toContain(res.body.encryptionKey);
    expect(['PRODUCTION_SAFE', 'DEVELOPMENT_DEFAULT', 'MISSING']).toContain(res.body.jwtSecret);

    for (const campo of ['a1Pfx', 'a1Password']) {
      expect(Object.keys(res.body), `falta ${campo}`).toContain(campo);
      expect(
        ['SEALED_CURRENT_KEY', 'LEGACY_KEY', 'ABSENT'],
        `${campo} com estado inesperado: ${res.body[campo]}`,
      ).toContain(res.body[campo]);
    }

    for (const campo of ['asaasSandbox', 'asaasProduction', 'asaasWebhook', 'email']) {
      expect(Object.keys(res.body), `falta ${campo}`).toContain(campo);
      expect(
        ['SEALED_CURRENT_KEY', 'LEGACY_KEY', 'ABSENT'],
        `${campo}.selo inesperado: ${res.body[campo]?.selo}`,
      ).toContain(res.body[campo].selo);
      expect(
        ['REQUIRED', 'NOT_REQUIRED'],
        `${campo}.trocaNoProvedor inesperado: ${res.body[campo]?.trocaNoProvedor}`,
      ).toContain(res.body[campo].trocaNoProvedor);
    }

    // A fila para a central e o estado da credencial dela entram no mesmo lugar:
    // 118 eventos ficaram doze dias parados porque só o log do boot contava.
    expect(typeof res.body.outbox?.pending).toBe('number');
    expect(res.body.centralSync?.readiness).toBeTruthy();
  });

  it('num banco sem segredo nenhum, tudo responde ABSENT', async () => {
    const dono = await loginForTest(app, {
      userId: 'dono-vazio',
      companyId: 'loja-vazia',
      profileCodes: ['admin_geral'],
    });
    const res = await request(app)
      .get('/api/v1/core/system/secrets-readiness')
      .set({ Authorization: `Bearer ${dono.body.accessToken}` });

    expect(res.body.a1Pfx).toBe('ABSENT');
    expect(res.body.a1Password).toBe('ABSENT');
    expect(res.body.asaasProduction.selo).toBe('ABSENT');
    // Ausente não pede troca: não há o que trocar.
    expect(res.body.asaasProduction.trocaNoProvedor).toBe('NOT_REQUIRED');
  });

  it('e o corpo inteiro não carrega valor de segredo nenhum', async () => {
    const dono = await loginForTest(app, {
      userId: 'dono-mudo',
      companyId: 'loja-muda',
      profileCodes: ['admin_geral'],
    });
    const res = await request(app)
      .get('/api/v1/core/system/secrets-readiness')
      .set({ Authorization: `Bearer ${dono.body.accessToken}` });

    const texto = JSON.stringify(res.body);
    // A chave de cifra deste processo não pode vazar nem para o dono.
    expect(texto).not.toContain(process.env.DEVORA_ENCRYPTION_KEY);
    expect(texto).not.toContain(process.env.DEVORA_JWT_SECRET);
    // Nem base64 comprido, que é a forma do texto cifrado.
    expect(texto).not.toMatch(/[A-Za-z0-9+/]{80,}={0,2}/);
  });
});
