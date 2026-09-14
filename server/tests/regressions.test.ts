/**
 * Regressões desta rodada.
 *
 * Cada teste aqui corresponde a um bug real que chegou a quebrar o sistema em
 * uso — não são testes estruturais.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import { resolve } from 'node:path';
import { createApp, buildCorsOriginCheck } from '../src/app.js';
import { resetDbForTests } from '../src/db/database.js';
import { getConnection, resolveDatabasePath } from '../src/db/sqlite.js';
import { loadEnv, resetEnvCacheForTests } from '../src/config/env.js';
import { loginForTest } from './helpers/auth.js';
import {
  linkUserToCompany,
  upsertCompany,
  upsertUser,
} from '../src/services/auth/IdentityService.js';

const app = createApp();

function allows(origin: string | undefined): boolean {
  let allowed = false;
  buildCorsOriginCheck(loadEnv())(origin, (_err, ok) => {
    allowed = ok === true;
  });
  return allowed;
}

describe('CORS', () => {
  // O frontend roda em 5173 e o default apontava só para 3000, então TODA
  // requisição do browser falhava no preflight e a tela dizia
  // "não foi possível conectar ao servidor".
  it('aceita a porta do Vite', () => {
    expect(allows('http://localhost:5173')).toBe(true);
  });

  it('aceita origem de rede local (PDV acessado por IP da LAN)', () => {
    expect(allows('http://192.168.0.105:5173')).toBe(true);
    expect(allows('http://10.0.0.42:3000')).toBe(true);
    expect(allows('http://172.16.5.9:5173')).toBe(true);
  });

  it('recusa origem externa', () => {
    expect(allows('https://evil.example.com')).toBe(false);
    expect(allows('http://8.8.8.8:5173')).toBe(false);
  });

  it('permite requisição sem Origin (curl, health check)', () => {
    expect(allows(undefined)).toBe(true);
  });

  it('em produção só vale o allowlist configurado', () => {
    resetEnvCacheForTests();
    // Guarda o estado exato para restaurar depois. Atribuir `undefined` a uma
    // variável de ambiente grava a STRING "undefined", o que faria o zod
    // rejeitar o enum e derrubar todas as requisições seguintes com 500.
    const snapshot = {
      DEVORA_API_ENV: process.env.DEVORA_API_ENV,
      DEVORA_JWT_SECRET: process.env.DEVORA_JWT_SECRET,
      DEVORA_ENCRYPTION_KEY: process.env.DEVORA_ENCRYPTION_KEY,
      DEVORA_FRONTEND_ORIGIN: process.env.DEVORA_FRONTEND_ORIGIN,
    };
    const restore = () => {
      for (const [key, value] of Object.entries(snapshot)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      resetEnvCacheForTests();
    };

    process.env.DEVORA_API_ENV = 'production';
    process.env.DEVORA_JWT_SECRET = 'segredo-de-producao-bem-longo-123456';
    process.env.DEVORA_ENCRYPTION_KEY = 'chave-de-producao-bem-longa-1234567890';
    process.env.DEVORA_FRONTEND_ORIGIN = 'https://erp.gruposampaio.com.br';
    try {
      const check = buildCorsOriginCheck(loadEnv());
      const test = (origin: string) => {
        let ok = false;
        check(origin, (_e, allowed) => {
          ok = allowed === true;
        });
        return ok;
      };
      expect(test('https://erp.gruposampaio.com.br')).toBe(true);
      // LAN não é liberada automaticamente em produção.
      expect(test('http://192.168.0.105:5173')).toBe(false);
    } finally {
      restore();
    }
  });
});

describe('caminho do banco', () => {
  // Resolver contra process.cwd() criava server/server/data/… ao rodar
  // `npm run dev --prefix server`: bancos diferentes conforme o diretório.
  it('não depende do diretório de execução', () => {
    const original = process.cwd();
    const first = resolveDatabasePath();
    try {
      process.chdir(resolve(original, '..'));
      expect(resolveDatabasePath()).toBe(first);
    } finally {
      process.chdir(original);
    }
  });

  it('nunca duplica o segmento server/', () => {
    expect(resolveDatabasePath().replace(/\\/g, '/')).not.toMatch(/server\/server/);
  });
});

describe('acesso sem senha: nenhuma rota de atalho existe, com variável nenhuma', () => {
  beforeEach(async () => {
    resetDbForTests();
    const companyId = upsertCompany({
      slug: 'oficina',
      legalName: 'Oficina Ltda',
      tradeName: 'Oficina',
      kind: 'workshop',
    });
    const pdv = await upsertUser({
      login: 'oficina.pdv',
      displayName: 'PDV Oficina',
      password: 'Senha@123',
    });
    linkUserToCompany(pdv, companyId, 'operador_caixa_oficina', true);
    const admin = await upsertUser({
      login: 'ADMIN',
      displayName: 'Administrador',
      password: 'admin@123',
    });
    linkUserToCompany(admin, companyId, 'admin_geral', true);
  });

  /**
   * O caminho sem senha morreu duas vezes, e este teste diz as duas.
   *
   * Primeiro o acesso por card, ligado por variável e desligado em produção
   * POR PADRÃO — padrão não é garantia. Depois o atalho de desenvolvimento,
   * cuja trava valia só com o ambiente DECLARADO — e o padrão é
   * `development`. Os dois saíram por inteiro: as rotas não existem, e as três
   * variáveis que os ligavam não abrem nada em ambiente nenhum (em produção,
   * a API nem sobe com elas ligadas — ver `producao-nao-entra-sem-senha`).
   */
  const ROTAS_ANTIGAS: Array<['get' | 'post', string]> = [
    ['get', '/api/v1/auth/quick-login'],
    ['get', '/api/v1/auth/quick-login/users'],
    ['post', '/api/v1/auth/quick-login'],
  ];

  for (const variavel of ['DEVORA_DEV_QUICK_LOGIN', 'VITE_DEV_QUICK_LOGIN', 'GRUPO_SAMPAIO_QUICK_LOGIN']) {
    it(`${variavel}=true não abre porta nenhuma: as rotas antigas respondem 404`, async () => {
      process.env[variavel] = 'true';
      resetEnvCacheForTests();
      try {
        for (const [metodo, rota] of ROTAS_ANTIGAS) {
          const res = await request(app)[metodo](rota).send({ userId: 'qualquer', companyId: 'qualquer' });
          expect(res.status, `${metodo.toUpperCase()} ${rota}`).toBe(404);
          expect(res.body.accessToken).toBeUndefined();
          expect(res.body.users).toBeUndefined();
        }
      } finally {
        delete process.env[variavel];
        resetEnvCacheForTests();
      }
    });
  }

  it('o PDV entra com usuário e senha', async () => {
    const res = await request(app)
      .post('/api/v1/auth/login')
      .send({ login: 'oficina.pdv', password: 'Senha@123' });
    expect(res.status).toBe(200);
    expect(res.body.accessToken).toBeTruthy();
    expect(res.body.user.profileCode).toBe('operador_caixa_oficina');
  });

  it('o PDV com senha errada é recusado', async () => {
    const res = await request(app)
      .post('/api/v1/auth/login')
      .send({ login: 'oficina.pdv', password: 'errada' });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.body.accessToken).toBeUndefined();
  });
});

describe('credenciais do seed', () => {
  beforeEach(() => resetDbForTests());

  it('gestão e operação autenticam com as senhas definidas', async () => {
    const companyId = upsertCompany({
      slug: 'preco-justo',
      legalName: 'Preço Justo Ltda',
      tradeName: 'Preço Justo',
    });
    const manager = await upsertUser({
      login: 'CARLOSGERENTE',
      displayName: 'Carlos Gerente',
      password: 'admin@123',
    });
    linkUserToCompany(manager, companyId, 'gestor', true);

    const ok = await request(app)
      .post('/api/v1/auth/login')
      .send({ login: 'CARLOSGERENTE', password: 'admin@123' });
    expect(ok.status).toBe(200);
    expect(ok.body.user.profileCode).toBe('gestor');

    const bad = await request(app)
      .post('/api/v1/auth/login')
      .send({ login: 'CARLOSGERENTE', password: 'admin@1234' });
    expect(bad.status).toBe(401);
  });
});

describe('oficina — kanban', () => {
  let token: string;

  beforeEach(async () => {
    resetDbForTests();
    // O login provisiona a empresa; a oficina é criada dentro dela. Uma
    // oficina é um espaço de trabalho da empresa, nunca uma empresa nova.
    const res = await loginForTest(app, {
      userId: 'mecanico',
      companyId: 'oficina-co',
      profileCodes: ['gerente_oficina'],
    });
    token = res.body.accessToken;

    getConnection()
      .prepare(
        `INSERT INTO core_workshops (id, company_id, slug, name, kind, active, created_at)
         VALUES ('ws-mob', 'oficina-co', 'oficina-mobilidade', 'Mobilidade', 'mobility', 1, ?)`,
      )
      .run(new Date().toISOString());
  });

  async function openAndAssume(auth: Record<string, string>) {
    const created = await request(app)
      .post('/api/v1/core/workshop/orders')
      .set(auth)
      .send({ customerName: 'Maria', complaint: 'Não carrega' });
    expect(created.status).toBe(201);
    await request(app)
      .post(`/api/v1/core/workshop/orders/${created.body.id}/assume`)
      .set(auth)
      .send({ status: 'em_andamento', comment: 'Assumindo o serviço' });
    return created.body.id as string;
  }

  it('a movimentação persiste no servidor', async () => {
    const auth = { Authorization: `Bearer ${token}` };
    const orderId = await openAndAssume(auth);

    const moved = await request(app)
      .post(`/api/v1/core/workshop/orders/${orderId}/move`)
      .set(auth)
      .send({ status: 'aguardando_peca', comment: 'Peça encomendada' });
    expect(moved.status).toBe(200);

    // Nova leitura (equivale a refresh / outro computador).
    const reread = await request(app).get('/api/v1/core/workshop/orders').set(auth);
    const order = reread.body.items.find((o: { id: string }) => o.id === orderId);
    expect(order.status).toBe('aguardando_peca');
  });

  it('recusa situação inexistente', async () => {
    const auth = { Authorization: `Bearer ${token}` };
    const orderId = await openAndAssume(auth);
    const res = await request(app)
      .post(`/api/v1/core/workshop/orders/${orderId}/move`)
      .set(auth)
      .send({ status: 'coluna_inventada' });
    expect(res.status).toBe(400);
  });

  /**
   * Rodada 55: a peça PROMETE em vez de baixar. O que este caso trava continua
   * sendo o mesmo — a OS não pode mexer no estoque duas vezes —, mas o eixo
   * mudou: o saldo físico fica de pé e o que anda é a reserva. Afirmar
   * `quantity === 3` aqui seria travar o comportamento antigo com o nome do
   * novo.
   */
  it('peça na OS promete o estoque da oficina uma única vez', async () => {
    const auth = { Authorization: `Bearer ${token}` };
    const product = await request(app)
      .post('/api/v1/core/products')
      .set(auth)
      .send({ name: 'Bateria 48V', priceCents: 45000 });
    await request(app).post('/api/v1/core/stock/movements').set(auth).send({
      productId: product.body.id,
      movementType: 'in',
      quantity: 4,
      referenceType: 'entrada',
      referenceId: 'nf-oficina',
    });

    const orderId = await openAndAssume(auth);
    const withPart = await request(app)
      .post(`/api/v1/core/workshop/orders/${orderId}/parts`)
      .set(auth)
      .send({ productId: product.body.id, quantity: 1 });
    expect(withPart.status).toBe(201);
    expect(withPart.body.parts_cents).toBe(45000);

    const stock = await request(app).get('/api/v1/core/stock').set(auth);
    // A peça está na prateleira, com dono: o físico não andou, o disponível sim.
    expect(stock.body.items[0].quantity).toBe(4);
    expect(stock.body.items[0].reserved).toBe(1);

    // E prometer de novo a MESMA linha não promete duas vezes.
    const repetido = await request(app)
      .post(`/api/v1/core/workshop/orders/${orderId}/parts`)
      .set(auth)
      .send({ productId: product.body.id, quantity: 1 });
    expect(repetido.status).toBe(201);
    const depois = await request(app).get('/api/v1/core/stock').set(auth);
    expect(depois.body.items[0].reserved).toBe(2);
    expect(depois.body.items[0].quantity).toBe(4);
  });

  it('não enxerga OS de outra empresa', async () => {
    const auth = { Authorization: `Bearer ${token}` };
    await openAndAssume(auth);

    const other = await loginForTest(app, {
      userId: 'outro',
      companyId: 'loja-x',
      profileCodes: ['gerente_loja'],
    });
    const res = await request(app)
      .get('/api/v1/core/workshop/orders')
      .set({ Authorization: `Bearer ${other.body.accessToken}` });
    expect(res.body.items ?? []).toHaveLength(0);
  });
});
