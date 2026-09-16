/**
 * ============================================================================
 * O CÓDIGO ADICIONAL SÓ ENTRA EM PRODUTO DA PRÓPRIA OPERAÇÃO (P00-prod-01)
 * ============================================================================
 *
 * O DEFEITO: `POST /products/:id/barcodes` era a única porta do produto que não
 * conferia de QUEM era o produto. O id vinha da URL e ia direto para o INSERT,
 * junto com o `company_id` de quem chamou: a Gringa mandava o id de um produto
 * da Preço Justo e recebia 201. Nascia uma linha em `core_product_barcodes` com
 * a empresa de uma loja e a mercadoria de outra — o estado que o isolamento por
 * empresa existe para impedir.
 *
 * As duas consequências, e nenhuma com tela que a explique:
 *
 *   - o código ficava QUEIMADO para quem o gravou. `findProductByAnyBarcode`
 *     procura pela empresa, achava a linha torta, e o cadastro do MESMO EAN no
 *     produto certo passava a ser recusado com "já pertence a outro produto" —
 *     sobre um produto que aquela operação não enxerga em lugar nenhum. A
 *     recusa do cadastro chegava a NOMEAR o produto alheio;
 *   - e o balcão da OUTRA loja passava a atender ao bipe daquele código, porque
 *     a busca casava o adicional sem olhar a empresa da linha.
 *
 * O CONSERTO tem duas metades, e as duas importam: a porta passa a responder
 * 404 (como as irmãs — grade, clone, faixas, kit, foto, PUT), e os leitores que
 * decidem "este código está livre?" conferem a empresa NO PRODUTO também, para
 * que a linha herdada de um banco antigo fique inerte em vez de continuar
 * queimando o código.
 *
 * ## Como cada guarda falha (quebrando de propósito)
 *
 *   - tire a conferência de dono de `addProductBarcode` e o 201 alheio volta;
 *   - tire `AND p.company_id = b.company_id` de `findProductByAnyBarcode` e o
 *     código volta a ficar queimado para quem é dono dele;
 *   - tire `codigo_adicional.company_id = p.company_id` de `CASOU_POR_CODIGO` e
 *     o balcão volta a atender ao bipe de um código que nunca foi dele.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { resetEnvCacheForTests } from '../src/config/env.js';
import { resetDbForTests } from '../src/db/database.js';
import { getConnection } from '../src/db/sqlite.js';
import { issueSession } from './helpers/sessao.js';

process.env.DEVORA_JWT_SECRET = 'test-jwt-secret-key';
process.env.DEVORA_ENCRYPTION_KEY = 'test-encryption-key-32-chars!!';

const PJ = 'preco-justo-codigos';
const GRINGA = 'gringa-codigos';

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

beforeEach(() => {
  resetEnvCacheForTests();
  resetDbForTests();
  app = createApp();
  auth('gerente_loja', PJ);
  auth('gerente_loja', GRINGA);
});

describe('o código adicional só entra em produto da própria operação (P00-prod-01)', () => {
  it('a outra empresa recebe 404 ao mandar o id de um produto da Preço Justo', async () => {
    const arroz = await criar({ name: 'Arroz Tipo 1 5kg', priceCents: 2590 });

    const invasao = await request(app)
      .post(`/api/v1/core/products/${arroz.id}/barcodes`)
      .set(auth('gerente_loja', GRINGA))
      .send({ barcode: '7890000000017' });
    expect(invasao.status, JSON.stringify(invasao.body)).toBe(404);
    expect(invasao.body.error.code).toBe('CORE_PRODUCT_NOT_FOUND');

    // Nada foi gravado: nem para a Gringa, nem para a Preço Justo.
    const gravadas = getConnection()
      .prepare('SELECT COUNT(*) AS n FROM core_product_barcodes')
      .get() as { n: number };
    expect(gravadas.n).toBe(0);
  });

  it('o dono continua acrescentando o código normalmente', async () => {
    const arroz = await criar({ name: 'Arroz Tipo 1 5kg', priceCents: 2590 });
    const r = await request(app)
      .post(`/api/v1/core/products/${arroz.id}/barcodes`)
      .set(auth('gerente_loja', PJ))
      .send({ barcode: '7890000000017' });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body.barcodes).toEqual(['7890000000017']);
    // E o bipe do fardo acha o arroz, marcado como casamento exato.
    const [achado] = await buscar('7890000000017');
    expect(achado.id).toBe(arroz.id);
    expect(Number(achado.matched_exact)).toBe(1);
  });

  it('o código não fica QUEIMADO: a Gringa cadastra o mesmo EAN no produto dela', async () => {
    const arroz = await criar({ name: 'Arroz Tipo 1 5kg', priceCents: 2590 });
    await request(app)
      .post(`/api/v1/core/products/${arroz.id}/barcodes`)
      .set(auth('gerente_loja', GRINGA))
      .send({ barcode: '7890000000017' });

    const vestido = await criar({ name: 'Vestido Longo', priceCents: 19900 }, GRINGA);
    const proprio = await request(app)
      .post(`/api/v1/core/products/${vestido.id}/barcodes`)
      .set(auth('gerente_loja', GRINGA))
      .send({ barcode: '7890000000017' });
    expect(proprio.status, JSON.stringify(proprio.body)).toBe(201);
    expect(proprio.body.barcodes).toEqual(['7890000000017']);
  });

  it('linha herdada de outra empresa não faz o balcão da Preço Justo atender ao bipe', async () => {
    const arroz = await criar({ name: 'Arroz Tipo 1 5kg', priceCents: 2590 });
    // O estado que o banco antigo já tem: a linha existe, com a empresa ERRADA.
    getConnection()
      .prepare(
        `INSERT INTO core_product_barcodes (id, company_id, product_id, barcode, created_at)
         VALUES ('bc-torto', ?, ?, '7890000000017', ?)`,
      )
      .run(GRINGA, arroz.id, new Date().toISOString());

    expect(await buscar('7890000000017')).toEqual([]);
    // E o nome do produto alheio não sai na recusa do cadastro da Gringa.
    const vestido = await criar({ name: 'Vestido Longo', priceCents: 19900 }, GRINGA);
    const r = await request(app)
      .put(`/api/v1/core/products/${vestido.id}`)
      .set(auth('gerente_loja', GRINGA))
      .send({ barcode: '7890000000017' });
    expect(JSON.stringify(r.body)).not.toContain('Arroz');
  });
});
