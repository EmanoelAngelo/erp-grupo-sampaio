/**
 * O bloqueio de login protege a conta — não pode virar arma contra ela.
 *
 * Até a rodada 34 o bloqueio contava falhas POR LOGIN, de qualquer origem.
 * Qualquer pessoa que soubesse o login do gerente (e ele aparece em cupom,
 * em e-mail, em crachá) errava a senha cinco vezes de um celular e o gerente
 * ficava 15 minutos fora do próprio caixa — no sábado, na hora do movimento.
 * E uma rota PÚBLICA, `GET /auth/lockout/:login`, confirmava para quem trancou
 * que deu certo. Nenhuma tela a chamava.
 *
 * O conserto é em duas partes:
 *
 *   1. O bloqueio conta POR PAR (login + endereço de origem). Quem erra cinco
 *      vezes de um aparelho tranca aquele aparelho para aquele login — o
 *      gerente, do caixa dele, continua entrando. Para não deixar o caminho
 *      livre para força bruta distribuída, existe um SEGUNDO teto, por login,
 *      bem mais alto: ninguém tenta 50 senhas em 15 minutos de boa-fé.
 *   2. A rota de diagnóstico some. Não há tela para ela, e o único uso real
 *      que tinha era dizer ao atacante que funcionou.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { resetDbForTests } from '../src/db/database.js';
import {
  linkUserToCompany,
  upsertCompany,
  upsertUser,
} from '../src/services/auth/IdentityService.js';

const SENHA = 'Senha@Forte123';
let app: ReturnType<typeof createApp>;

/** O app visto como se a conexão viesse do endereço dado. */
function vistoDe(endereco: string) {
  const casca = express();
  casca.use((req, _res, next) => {
    Object.defineProperty(req.socket, 'remoteAddress', { value: endereco, configurable: true });
    next();
  });
  casca.use(app);
  return casca;
}

async function errar(endereco: string, vezes: number) {
  for (let i = 0; i < vezes; i += 1) {
    await request(vistoDe(endereco))
      .post('/api/v1/auth/login')
      .send({ login: 'GERENTE', password: 'errada' });
  }
}

beforeEach(async () => {
  resetDbForTests();
  app = createApp();
  const companyId = upsertCompany({ slug: 'preco-justo', legalName: 'Preço Justo Ltda', tradeName: 'Preço Justo' });
  const userId = await upsertUser({ login: 'GERENTE', displayName: 'Gerente', password: SENHA });
  linkUserToCompany(userId, companyId, 'gerente_loja', true);
});

describe('o bloqueio é por par login + origem', () => {
  it('quem erra cinco vezes de um aparelho tranca AQUELE aparelho', async () => {
    await errar('192.168.0.50', 5);
    const doAtacante = await request(vistoDe('192.168.0.50'))
      .post('/api/v1/auth/login')
      .send({ login: 'GERENTE', password: SENHA });
    expect(doAtacante.status).toBe(429);
    expect(doAtacante.body.error.code).toBe('API_LOGIN_LOCKED');
  });

  it('o gerente, do caixa dele, continua entrando enquanto o atacante está trancado', async () => {
    await errar('192.168.0.50', 5);
    const doCaixa = await request(vistoDe('192.168.0.10'))
      .post('/api/v1/auth/login')
      .send({ login: 'GERENTE', password: SENHA });
    expect(doCaixa.status).toBe(200);
    expect(doCaixa.body.accessToken).toBeTruthy();
  });

  it('força bruta distribuída bate no teto por login', async () => {
    // 13 aparelhos × 4 erros cada: nenhum par chega a 5, mas o login soma 52,
    // acima do teto de 50. (A primeira versão somava 40 e passava sem provar
    // nada — o teto é o que está no serviço, não o que parecia razoável.)
    for (let i = 1; i <= 13; i += 1) {
      await errar(`10.0.0.${i}`, 4);
    }
    const doCaixa = await request(vistoDe('192.168.0.10'))
      .post('/api/v1/auth/login')
      .send({ login: 'GERENTE', password: SENHA });
    expect(doCaixa.status).toBe(429);
  });

  it('abaixo dos dois tetos, o caixa entra', async () => {
    for (let i = 1; i <= 5; i += 1) {
      await errar(`10.0.0.${i}`, 4);
    }
    // 20 falhas por login, nenhum par em 5: ainda está dentro do permitido.
    const doCaixa = await request(vistoDe('192.168.0.10'))
      .post('/api/v1/auth/login')
      .send({ login: 'GERENTE', password: SENHA });
    expect(doCaixa.status).toBe(200);
  });
});

describe('a rota de diagnóstico', () => {
  it('não existe mais — nem para dizer que o bloqueio funcionou', async () => {
    await errar('192.168.0.50', 5);
    const res = await request(app).get('/api/v1/auth/lockout/GERENTE');
    expect(res.status).toBe(404);
    expect(res.body.locked).toBeUndefined();
    expect(res.body.failures).toBeUndefined();
  });
});
