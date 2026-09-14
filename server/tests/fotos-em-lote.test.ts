/**
 * FOTOS EM LOTE — o casamento arquivo→produto (rodada 45).
 *
 * O dono fotografa a loja inteira de uma vez e exporta do computador no fim.
 * Subir foto POR PRODUTO, navegando cadastro a cadastro, é a visita que nunca
 * acontece. O desenho: cada arquivo é NOMEADO com o código de barras ou o
 * código interno do produto (7891234567895.jpg, PB-1.jpg), e o servidor
 * resolve os nomes em lote — a tela mostra o que casou, o que ficou sem
 * produto, e sobe cada foto pela rota que já existia.
 *
 * O upload em si NÃO ganhou rota nova: POST /products/:id/images continua
 * sendo o único escritor de imagem. Esta rota só RESOLVE nomes — é leitura.
 *
 * ## Como cada guarda falha (quebrando de propósito)
 *
 *   - resolva sem cortar a extensão e "7890000000031.jpg" não casa nada;
 *   - troque o corte por empresa e a foto da Gringa casa produto do Preço
 *     Justo — o caso do isolamento fica vermelho.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { resetDbForTests } from '../src/db/database.js';
import { getConnection } from '../src/db/sqlite.js';
import { loginForTest } from './helpers/auth.js';

const app = createApp();
let auth: { Authorization: string };
let companyId: string;

function criarProduto(id: string, extras: { barcode?: string; internalCode: string; name: string; companyId?: string }) {
  const agora = new Date().toISOString();
  getConnection()
    .prepare(
      `INSERT INTO core_products (id, company_id, internal_code, barcode, name, unit, cost_cents,
                                  price_cents, active, publish_online, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'UN', 500, 1000, 1, 1, ?, ?)`,
    )
    .run(id, extras.companyId ?? companyId, extras.internalCode, extras.barcode ?? null, extras.name, agora, agora);
}

async function resolver(names: string[]) {
  return request(app)
    .post('/api/v1/core/products/fotos-em-lote/resolver')
    .set(auth)
    .send({ names });
}

beforeEach(async () => {
  resetDbForTests();
  const res = await loginForTest(app, {
    userId: 'gerente-fotos',
    companyId: 'loja-fotos',
    profileCodes: ['gerente_loja'],
  });
  auth = { Authorization: `Bearer ${res.body.accessToken}` };
  companyId = res.body.company.id;

  criarProduto('p-barras', { barcode: '7890000000031', internalCode: 'PB-1', name: 'Produto do barras' });
  criarProduto('p-interno', { internalCode: 'COD-77', name: 'Produto do codigo' });
});

describe('o casamento por nome de arquivo', () => {
  it('casa por código de barras e por código interno, ignorando a extensão e a caixa', async () => {
    const res = await resolver(['7890000000031.jpg', 'cod-77.JPEG', 'nada-disso.png']);
    expect(res.status).toBe(200);
    const [porBarras, porCodigo, semProduto] = res.body.items;

    expect(porBarras.productId).toBe('p-barras');
    expect(porBarras.productName).toBe('Produto do barras');
    expect(porBarras.code).toBe('7890000000031');

    // 'cod-77.JPEG' minúsculo/maiúsculo casa COD-77 — arquivo nomeado à mão.
    expect(porCodigo.productId).toBe('p-interno');

    expect(semProduto.productId).toBeNull();
    expect(semProduto.code).toBe('nada-disso');
  });

  it('código de barras EXTRA (core_product_barcodes) também casa', async () => {
    getConnection()
      .prepare(
        `INSERT INTO core_product_barcodes (id, company_id, product_id, barcode, created_at)
         VALUES ('bc-1', ?, 'p-interno', '7899999999999', ?)`,
      )
      .run(companyId, new Date().toISOString());
    const res = await resolver(['7899999999999.webp']);
    expect(res.body.items[0].productId).toBe('p-interno');
  });

  it('diz se o produto JÁ tem foto — acrescentar não é o mesmo que estrear', async () => {
    getConnection()
      .prepare(
        `INSERT INTO core_product_images (id, company_id, product_id, url, position, is_primary, created_at)
         VALUES ('img-1', ?, 'p-barras', '/uploads/produtos/x.jpg', 0, 1, ?)`,
      )
      .run(companyId, new Date().toISOString());
    const res = await resolver(['7890000000031.jpg', 'COD-77.png']);
    expect(res.body.items[0].temFoto).toBe(true);
    expect(res.body.items[1].temFoto).toBe(false);
  });

  it('caixa EXATA decide quando dois códigos diferem só na caixa — a revisão mordeu aqui', async () => {
    // 'PB-1' e 'pb-1' coexistem legalmente (o UNIQUE é case-sensitive). O
    // NOCASE sozinho devolvia o primeiro da varredura — foto no produto
    // errado, em silêncio.
    criarProduto('p-minusculo', { internalCode: 'pb-1', name: 'Produto minusculo' });
    const res = await resolver(['pb-1.jpg', 'PB-1.jpg']);
    expect(res.body.items[0].productId).toBe('p-minusculo');
    expect(res.body.items[1].productId).toBe('p-barras');
  });

  it('NÃO casa produto de outra empresa — foto da Gringa não veste produto alheio', async () => {
    const outra = await loginForTest(app, {
      userId: 'gerente-outra',
      companyId: 'outra-loja',
      profileCodes: ['gerente_loja'],
    });
    criarProduto('p-alheio', {
      barcode: '7891111111111',
      internalCode: 'AL-1',
      name: 'Produto alheio',
      companyId: outra.body.company.id,
    });
    const res = await resolver(['7891111111111.jpg']);
    expect(res.body.items[0].productId).toBeNull();
  });

  it('lote grande demais é recusado — 500 nomes é foto de loja, 5000 é abuso', async () => {
    const nomes = Array.from({ length: 501 }, (_, i) => `x${i}.jpg`);
    const res = await resolver(nomes);
    expect(res.status).toBe(400);
  });
});
