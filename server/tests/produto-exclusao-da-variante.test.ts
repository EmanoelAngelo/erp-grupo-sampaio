/**
 * EXCLUIR UM TAMANHO SOZINHO AVISA A CENTRAL COMO VARIANTE.
 *
 * A central guarda produto e variante em tabelas diferentes (`erp_products` e
 * `erp_product_variants`). O tombstone de um tamanho excluído sozinho ia como
 * `product.deactivated` — e o Projector criaria em `erp_products` uma linha
 * para um id que nunca foi produto lá, deixando a variante viva na tabela dela.
 *
 * O modelo continua lá, intacto: excluir um tamanho não mexe na grade vizinha.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { resetEnvCacheForTests } from '../src/config/env.js';
import { resetDbForTests } from '../src/db/database.js';
import { getConnection } from '../src/db/sqlite.js';
import { generateVariants } from '../src/services/core/VariantService.js';
import { issueSession } from './helpers/sessao.js';

process.env.DEVORA_JWT_SECRET = 'test-jwt-secret-key';
process.env.DEVORA_ENCRYPTION_KEY = 'test-encryption-key-32-chars!!';

const EMPRESA = 'company-exclusao-variante';

function auth(): { Authorization: string } {
  const s = issueSession({ userId: 'u-gerente-var', companyId: EMPRESA, profileCodes: ['gerente_loja'] });
  return { Authorization: `Bearer ${s.accessToken}` };
}

let app: ReturnType<typeof createApp>;

beforeEach(() => {
  resetEnvCacheForTests();
  resetDbForTests();
  app = createApp();
});

describe('excluir só um tamanho da grade', () => {
  it('apaga o tamanho, mantém o modelo e o irmão, e manda o tombstone de VARIANTE', async () => {
    const criado = await request(app)
      .post('/api/v1/core/products')
      .set(auth())
      .send({ name: 'Camiseta Polo', priceCents: 5000 });
    expect(criado.status, JSON.stringify(criado.body)).toBe(201);
    const modelo = String(criado.body.id);
    const grade = generateVariants({ companyId: EMPRESA, productId: modelo, axes: { tamanho: ['P', 'M'] } });
    const [p, m] = grade.created.map((v) => String((v as { id: string }).id));

    const res = await request(app).delete(`/api/v1/core/products/${p}`).set(auth());
    expect(res.status, JSON.stringify(res.body)).toBe(200);

    const existe = (id: string) =>
      (getConnection().prepare('SELECT COUNT(*) AS n FROM core_products WHERE id = ?').get(id) as { n: number }).n;
    expect(existe(p)).toBe(0);
    expect(existe(m)).toBe(1);
    expect(existe(modelo)).toBe(1);

    const evento = getConnection()
      .prepare(
        `SELECT event_type, aggregate_type, operation FROM core_outbox
          WHERE aggregate_id = ? ORDER BY seq DESC LIMIT 1`,
      )
      .get(p) as { event_type: string; aggregate_type: string; operation: string };
    expect(evento).toEqual({
      event_type: 'product_variant.upserted',
      aggregate_type: 'product_variant',
      operation: 'delete',
    });
  });
});
