/**
 * A numeração das séries fiscais, pela rota.
 *
 * A série é o que o checklist de emissão cobra em `serie:FAIL` — e até a
 * rodada 33 ela só existia por rota, sem tela. Ao ligar a tela, os valores
 * que a tela pode mandar passaram a importar: "série" é um campo de texto, e
 * um campo de texto aceita vazio, letra e número quebrado.
 *
 * O que se prova aqui é a recusa COM MOTIVO. `Number('') === 0` e
 * `Number('abc') === NaN` chegavam ao bind do INSERT, onde o SQLite responde
 * "datatype mismatch" — 500 cru numa rota de configuração, exatamente como
 * acontecia na trilha de auditoria antes da rodada 32.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { resetDbForTests } from '../src/db/database.js';
import {
  linkUserToCompany,
  upsertCompany,
  upsertUser,
} from '../src/services/auth/IdentityService.js';

const app = createApp();
const PASSWORD = 'Teste@Serie2026';

let companyId: string;
let gerente: { Authorization: string };

beforeEach(async () => {
  resetDbForTests();
  companyId = upsertCompany({
    slug: 'preco-justo',
    legalName: 'Preço Justo Ltda',
    tradeName: 'Preço Justo',
  });
  const userId = await upsertUser({
    login: 'GERENTESERIE',
    displayName: 'Gerente Série',
    password: PASSWORD,
  });
  linkUserToCompany(userId, companyId, 'gerente_loja', true);
  const res = await request(app)
    .post('/api/v1/auth/login')
    .send({ login: 'GERENTESERIE', password: PASSWORD });
  expect(res.status).toBe(200);
  gerente = { Authorization: `Bearer ${res.body.accessToken}` };
});

describe('POST /core/fiscal/series', () => {
  it('cria a série e a devolve na listagem', async () => {
    const criar = await request(app)
      .post('/api/v1/core/fiscal/series')
      .set(gerente)
      .send({ model: '65', serie: 1, nextNumber: 1 });
    expect(criar.status).toBe(200);

    const lista = await request(app).get('/api/v1/core/fiscal/series').set(gerente);
    expect(lista.status).toBe(200);
    const nfce = lista.body.items.find((i: { model: string }) => i.model === '65');
    expect(nfce.series).toEqual([{ serie: 1, nextNumber: 1, active: true }]);
  });

  it('recusa série que não é número, com motivo, em vez de 500', async () => {
    const res = await request(app)
      .post('/api/v1/core/fiscal/series')
      .set(gerente)
      .send({ model: '65', serie: 'abc', nextNumber: 1 });

    // O que importa é o 400: um 500 aqui seria o SQLite reclamando do bind,
    // e a tela mostraria "erro inesperado" para um campo mal preenchido.
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('CORE_FISCAL_SERIE_INVALID');

    // E nada foi gravado — a recusa não pode deixar meia série para trás.
    const lista = await request(app).get('/api/v1/core/fiscal/series').set(gerente);
    const nfce = lista.body.items.find((i: { model: string }) => i.model === '65');
    expect(nfce.series).toEqual([]);
  });

  it('recusa série fora da faixa 0–999 do layout da NF-e', async () => {
    for (const serie of [-1, 1000, 1.5]) {
      const res = await request(app)
        .post('/api/v1/core/fiscal/series')
        .set(gerente)
        .send({ model: '65', serie, nextNumber: 1 });
      expect(res.status, `série ${serie} deveria ser recusada`).toBe(400);
      expect(res.body.error.code).toBe('CORE_FISCAL_SERIE_INVALID');
    }
  });

  it('recusa série ausente em vez de entendê-la como série 0', async () => {
    /*
      Este é o caminho REAL da tela, e ele não passa por "abc": o campo é
      texto, o `Number('abc')` do navegador vira NaN, e `JSON.stringify` grava
      NaN como `null`. No servidor, `Number(null)` é 0 — que está dentro da
      faixa 0–999 e seria aceito. O efeito: quem digitou uma letra ganha uma
      série 0 gravada, sem aviso, e emite nota na série errada.
    */
    for (const serie of [null, undefined, '']) {
      const res = await request(app)
        .post('/api/v1/core/fiscal/series')
        .set(gerente)
        .send({ model: '65', serie, nextNumber: 1 });
      expect(res.status, `série ${JSON.stringify(serie)} deveria ser recusada`).toBe(400);
      expect(res.body.error.code).toBe('CORE_FISCAL_SERIE_INVALID');
    }

    // A série 0 é válida quando pedida de propósito — o layout permite.
    const zero = await request(app)
      .post('/api/v1/core/fiscal/series')
      .set(gerente)
      .send({ model: '65', serie: 0, nextNumber: 1 });
    expect(zero.status).toBe(200);
  });

  it('recusa modelo que não é 55 nem 65', async () => {
    // Sem esta recusa a gravação "dá certo" para o modelo 99, o checklist
    // continua dizendo serie:FAIL, e quem configurou não entende por quê.
    const res = await request(app)
      .post('/api/v1/core/fiscal/series')
      .set(gerente)
      .send({ model: '99', serie: 1, nextNumber: 1 });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('CORE_FISCAL_MODEL_INVALID');
  });

  it('não deixa a numeração retroceder', async () => {
    await request(app)
      .post('/api/v1/core/fiscal/series')
      .set(gerente)
      .send({ model: '65', serie: 1, nextNumber: 500 });

    const res = await request(app)
      .post('/api/v1/core/fiscal/series')
      .set(gerente)
      .send({ model: '65', serie: 1, nextNumber: 200 });

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('CORE_FISCAL_NUMBER_REGRESSION');
  });

  it('atendente não configura numeração fiscal', async () => {
    const userId = await upsertUser({
      login: 'ATENDENTESERIE',
      displayName: 'Atendente',
      password: PASSWORD,
    });
    linkUserToCompany(userId, companyId, 'atendente', true);
    const login = await request(app)
      .post('/api/v1/auth/login')
      .send({ login: 'ATENDENTESERIE', password: PASSWORD });

    const res = await request(app)
      .post('/api/v1/core/fiscal/series')
      .set({ Authorization: `Bearer ${login.body.accessToken}` })
      .send({ model: '65', serie: 1, nextNumber: 1 });

    expect(res.status).toBe(403);
  });
});
