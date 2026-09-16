/**
 * ============================================================================
 * O BALCÃO ACHA O SKU COMO O CADASTRO O COBRA (P00-prod-02)
 * ============================================================================
 *
 * O DEFEITO tinha duas metades, e as duas nascem da mesma causa: a busca do
 * balcão escrevia a pergunta "o termo é um código deste produto?" TRÊS VEZES em
 * SQL — na marca `matched_exact`, no filtro e na ordenação — e as três já
 * tinham divergido.
 *
 *   - O SKU era comparado com CAIXA EXATA (`p.sku = ?`), enquanto o CADASTRO
 *     recusa um código novo que colida com o SKU de outro produto EM QUALQUER
 *     CAIXA (`upper(sku) = upper(?)`), dizendo com todas as letras "o bipe no
 *     balcão acha os dois". O bipe não achava: "sh-200" não trazia o produto de
 *     SKU "SH-200". E "nenhum produto encontrado" para algo que está na mão da
 *     pessoa tem um desfecho conhecido — ela cadastra o item de novo, e o saldo
 *     racha entre dois cadastros que nenhum dos dois diz a verdade.
 *   - E o SKU ficava de fora da MARCA: achado por SKU, o item abria a LISTA em
 *     vez de entrar no carrinho. A tela compensava com uma comparação própria
 *     (`achado.sku === alvo`), que o servidor não conhecia e que também era
 *     sensível a caixa.
 *
 * O CONSERTO é uma expressão SQL só (`CASOU_POR_CODIGO`), usada nos três
 * lugares — é ela que impede a quarta divergência.
 *
 * ## Como cada guarda falha (quebrando de propósito)
 *
 *   - troque `upper(p.sku) = upper(?)` por `p.sku = ?` e "sh-200" some da busca;
 *   - tire o SKU de `CASOU_POR_CODIGO` e o achado por SKU volta a abrir a lista.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { resetEnvCacheForTests } from '../src/config/env.js';
import { resetDbForTests } from '../src/db/database.js';
import { issueSession } from './helpers/sessao.js';

process.env.DEVORA_JWT_SECRET = 'test-jwt-secret-key';
process.env.DEVORA_ENCRYPTION_KEY = 'test-encryption-key-32-chars!!';

const PJ = 'preco-justo-sku';
const GRINGA = 'gringa-sku';

let app: ReturnType<typeof createApp>;

function auth(perfil: string, empresa = PJ): { Authorization: string } {
  const s = issueSession({ userId: `u-${perfil}-${empresa}`, companyId: empresa, profileCodes: [perfil] });
  return { Authorization: `Bearer ${s.accessToken}` };
}

async function criar(body: Record<string, unknown>, empresa = PJ) {
  const r = await request(app)
    .post('/api/v1/core/products')
    .set(auth('gerente_loja', empresa))
    .send(body);
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r.body as Record<string, unknown> & { id: string };
}

/** A busca do balcão, com o token do caixa da loja — o login do PDV. */
async function buscar(q: string, empresa = PJ) {
  const r = await request(app)
    .get('/api/v1/core/products/search')
    .query({ q })
    .set(auth('operador_caixa_loja', empresa));
  expect(r.status).toBe(200);
  return r.body.items as Record<string, unknown>[];
}

beforeEach(async () => {
  resetEnvCacheForTests();
  resetDbForTests();
  app = createApp();
  auth('gerente_loja', PJ);
  auth('gerente_loja', GRINGA);
  await criar({ name: 'Shampoo Anticaspa 200ml', sku: 'SH-200', priceCents: 2990 });
});

describe('a busca do balcão acha o SKU como o cadastro o cobra (P00-prod-02)', () => {
  it('digitar o SKU em outra caixa acha o produto', async () => {
    for (const termo of ['SH-200', 'sh-200', 'Sh-200']) {
      const itens = await buscar(termo);
      expect(itens.map((i) => i.name), termo).toEqual(['Shampoo Anticaspa 200ml']);
    }
  });

  it('o SKU conta como casamento exato — o item entra no carrinho, não na lista', async () => {
    for (const termo of ['SH-200', 'sh-200']) {
      const [achado] = await buscar(termo);
      expect(Number(achado.matched_exact), termo).toBe(1);
    }
  });

  it('a busca por NOME continua não sendo casamento exato', async () => {
    const [achado] = await buscar('Shampoo');
    expect(Number(achado.matched_exact)).toBe(0);
  });

  it('o SKU de outra empresa continua invisível', async () => {
    await criar({ name: 'Vestido Longo', sku: 'VL-1', priceCents: 19900 }, GRINGA);
    expect(await buscar('vl-1')).toEqual([]);
  });
});
