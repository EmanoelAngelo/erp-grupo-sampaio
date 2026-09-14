process.env.TZ = 'UTC';
process.env.DEVORA_API_ENV = 'test';

/**
 * A ETIQUETA DA BALANÇA LIGADA PELA ROTA (D-pdv-teclado-16).
 *
 * O serviço já sabia ler a etiqueta que a balança imprime (prefixo 21–29, PLU e
 * peso embutidos), mas nenhuma tela conseguia declarar o formato: sem rota, a
 * leitura ficava pronta e desligada para sempre. Aqui a gestão declara, o PDV
 * lê a etiqueta pela busca de sempre, e desligar volta a busca ao normal. O caixa
 * não configura (403): é cadastro da operação.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { resetDbForTests } from '../src/db/database.js';
import { linkUserToCompany, upsertCompany, upsertUser } from '../src/services/auth/IdentityService.js';
import { digitoVerificadorGtin } from '../src/services/core/Gtin.js';

const app = createApp();
const SENHA = 'Senha@Balanca2026';
let loja: string;
let gestor: { Authorization: string };
let caixa: { Authorization: string };

async function entrar(login: string) {
  const r = await request(app).post('/api/v1/auth/login').send({ login, password: SENHA, companyId: loja });
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return { Authorization: `Bearer ${r.body.accessToken}` };
}
const comVerificador = (doze: string) => `${doze}${digitoVerificadorGtin(doze)}`;

beforeAll(async () => {
  resetDbForTests();
  loja = upsertCompany({ slug: 'preco-justo', legalName: 'Preço Justo Comércio Ltda', tradeName: 'Preço Justo' });
  const g = await upsertUser({ login: 'GESTOR.BALANCA', displayName: 'Gestor', password: SENHA });
  linkUserToCompany(g, loja, 'gerente_loja', true);
  const c = await upsertUser({ login: 'CAIXA.BALANCA', displayName: 'Caixa', password: SENHA });
  linkUserToCompany(c, loja, 'operador_caixa_loja', true);
  gestor = await entrar('GESTOR.BALANCA');
  caixa = await entrar('CAIXA.BALANCA');
}, 60_000);

describe('declarar a etiqueta da balança', () => {
  it('sem declaração, a configuração é nula', async () => {
    const r = await request(app).get('/api/v1/core/catalog/scale-label').set(gestor);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.config).toBeNull();
  });

  it('o prefixo 20 é recusado: é o dos códigos internos que o sistema gera', async () => {
    const r = await request(app).put('/api/v1/core/catalog/scale-label').set(gestor)
      .send({ prefixo: '20', digitosDoPlu: 5, valorEmbutido: 'peso' });
    expect(r.status).toBe(400);
    expect(r.body.error?.code).toBe('CORE_SCALE_PREFIX_RESERVED');
  });

  it('o caixa não configura nem lê a declaração (403)', async () => {
    const put = await request(app).put('/api/v1/core/catalog/scale-label').set(caixa)
      .send({ prefixo: '21', digitosDoPlu: 5, valorEmbutido: 'peso' });
    expect(put.status).toBe(403);
    expect((await request(app).get('/api/v1/core/catalog/scale-label').set(caixa)).status).toBe(403);
  });

  it('declarada, a etiqueta da balança é lida pela busca do PDV; desligada, a busca volta ao normal', async () => {
    const put = await request(app).put('/api/v1/core/catalog/scale-label').set(gestor)
      .send({ prefixo: '21', digitosDoPlu: 5, valorEmbutido: 'peso' });
    expect(put.status, JSON.stringify(put.body)).toBe(200);
    expect(put.body.config).toMatchObject({ prefixo: '21', digitosDoPlu: 5, valorEmbutido: 'peso' });

    const p = await request(app).post('/api/v1/core/products').set(gestor)
      .send({ name: 'Queijo muçarela (kg)', priceCents: 4990, unit: 'KG', weighable: true, pluCode: '00123' });
    expect(p.status, JSON.stringify(p.body)).toBe(201);

    // 21 + PLU 00123 + 00352 gramas + verificador = 0,352 kg.
    const etiqueta = comVerificador('210012300352');
    const busca = await request(app).get(`/api/v1/core/products/search?q=${etiqueta}`).set(caixa);
    expect(busca.status, JSON.stringify(busca.body)).toBe(200);
    const achado = (busca.body.items as { id: string; balanca?: { quantidade?: number } }[]).find((i) => i.id === p.body.id);
    expect(achado, JSON.stringify(busca.body)).toBeTruthy();
    expect(achado!.balanca?.quantidade).toBeCloseTo(0.352, 3);

    const desliga = await request(app).put('/api/v1/core/catalog/scale-label').set(gestor).send({ config: null });
    expect(desliga.status, JSON.stringify(desliga.body)).toBe(200);
    expect(desliga.body.config).toBeNull();
    const depois = await request(app).get(`/api/v1/core/products/search?q=${etiqueta}`).set(caixa);
    const semBalanca = (depois.body.items as { id: string; balanca?: unknown }[]).find((i) => i.id === p.body.id);
    expect(semBalanca?.balanca).toBeFalsy();
  });
});
