/**
 * A tela bloqueia. A API respondia.
 *
 * Cinco rotas de leitura nasceram sem `requireProfile` enquanto as escritas ao
 * lado, sobre o MESMO recurso, exigiam gerente. O roteador do navegador manda
 * essas telas para `ROTA_GESTAO`, então na prática ninguém via — mas a API
 * respondia a qualquer sessão autenticada, e chamar API não exige tela.
 *
 * O que vazava:
 *
 *   - `/finance/setup` devolve o SALDO de todas as contas bancárias;
 *   - `/commissions/summary` devolve quanto cada vendedor ganhou no período;
 *   - `/commissions/setup` devolve as faixas e quem está em qual grupo;
 *   - `/acquirers` devolve as taxas negociadas com a operadora de cartão.
 *
 * O mecânico da oficina lia as quatro.
 *
 * ## Por que este arquivo assere status EXATO
 *
 * A suíte tinha testes de isolamento escritos como
 * `expect([200, 403, 404]).toContain(res.status)`. Um teste que aceita os três
 * desfechos possíveis não consegue falhar: ele passa se a rota proteger, se
 * vazar, e se nem existir. Aqui cada caso diz um número só — e cobra também o
 * 200 do gerente, porque guarda que bloqueia todo mundo "passa" no teste de
 * bloqueio e quebra o produto.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { loginForTest } from './helpers/auth.js';
import { createApp } from '../src/app.js';
import { resetEnvCacheForTests } from '../src/config/env.js';
import { resetDbForTests } from '../src/db/database.js';

process.env.DEVORA_JWT_SECRET = 'test-jwt-secret-key';
process.env.DEVORA_ENCRYPTION_KEY = 'test-encryption-key-32-chars!!';

/** As rotas que expõem folha de pagamento, banco ou negociação comercial. */
const ROTAS_SENSIVEIS = [
  '/api/v1/core/finance/setup',
  '/api/v1/core/commissions/summary',
  '/api/v1/core/commissions/setup',
  '/api/v1/core/acquirers',
] as const;

async function tokenDe(perfil: string): Promise<{ app: ReturnType<typeof createApp>; token: string }> {
  const app = createApp();
  const login = await loginForTest(app, {
    userId: `u-${perfil}`,
    companyId: 'company-1',
    profileCodes: [perfil],
  });
  return { app, token: login.body.accessToken as string };
}

beforeEach(() => {
  resetEnvCacheForTests();
  resetDbForTests();
});

describe('quem NÃO responde pelo dinheiro não lê o dinheiro', () => {
  for (const rota of ROTAS_SENSIVEIS) {
    it(`mecânico recebe 403 em ${rota}`, async () => {
      const { app, token } = await tokenDe('mecanico');
      const res = await request(app).get(rota).set('Authorization', `Bearer ${token}`);
      expect(res.status).toBe(403);
    });

    it(`atendente recebe 403 em ${rota}`, async () => {
      const { app, token } = await tokenDe('atendente');
      const res = await request(app).get(rota).set('Authorization', `Bearer ${token}`);
      expect(res.status).toBe(403);
    });
  }

  /**
   * O caixa é o caso mais fácil de errar: ele mexe com dinheiro o dia inteiro,
   * então parece natural liberar. Mas o que ele conta é a gaveta dele — não o
   * saldo bancário da empresa nem a comissão dos colegas.
   */
  it('operador de caixa também não lê o saldo bancário', async () => {
    const { app, token } = await tokenDe('operador_caixa_loja');
    const res = await request(app)
      .get('/api/v1/core/finance/setup')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(403);
  });

  it('sem token nenhum é 401, não 403', async () => {
    // A distinção importa: 401 diz "identifique-se", 403 diz "você não pode".
    const app = createApp();
    const res = await request(app).get('/api/v1/core/finance/setup');
    expect(res.status).toBe(401);
  });
});

describe('e quem responde continua lendo', () => {
  // Sem estes casos, uma guarda que negasse para TODO MUNDO passaria nos
  // testes acima e quebraria as telas de gestão em produção.
  for (const rota of ROTAS_SENSIVEIS) {
    it(`gerente de loja recebe 200 em ${rota}`, async () => {
      const { app, token } = await tokenDe('gerente_loja');
      const res = await request(app).get(rota).set('Authorization', `Bearer ${token}`);
      expect(res.status).toBe(200);
    });
  }

  it('gestor passa, como passa em tudo', async () => {
    const { app, token } = await tokenDe('gestor');
    const res = await request(app)
      .get('/api/v1/core/finance/setup')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
  });
});

/**
 * O contraste que define a régua.
 *
 * Nem toda leitura precisa de guarda, e proteger demais é tão errado quanto
 * proteger de menos: o caixa que não enxerga estoque não vende. Estas rotas
 * ficaram abertas DE PROPÓSITO, e o teste registra a decisão para que a
 * próxima varredura não as "conserte" por simetria.
 */
describe('o que fica aberto de propósito', () => {
  const OPERACIONAIS = [
    '/api/v1/core/stock/locations',
    '/api/v1/core/payment-methods',
    '/api/v1/core/labels/catalog',
    '/api/v1/core/scales/formats',
  ];

  for (const rota of OPERACIONAIS) {
    it(`mecânico continua lendo ${rota}`, async () => {
      const { app, token } = await tokenDe('mecanico');
      const res = await request(app).get(rota).set('Authorization', `Bearer ${token}`);
      expect(res.status).toBe(200);
    });
  }
});
