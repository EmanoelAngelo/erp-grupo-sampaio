/**
 * Administração da loja online.
 *
 * A regra que este arquivo protege: A ADMINISTRAÇÃO NÃO CRIA CATÁLOGO PARALELO.
 *
 * A autoridade sobre o que aparece na loja continua sendo
 * `core_products.publish_online`. Uma lista separada de "produtos da vitrine"
 * divergiria do cadastro no primeiro produto despublicado — e a loja passaria a
 * oferecer o que não se pode vender. Por isso até o destaque é sinalizador no
 * produto, e destacar exige estar publicado.
 *
 * A segunda: o que o gestor escreve TEM DE CHEGAR à vitrine. Configuração que
 * ninguém lê é tela de enfeite.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { resetDbForTests } from '../src/db/database.js';
import { loginForTest } from './helpers/auth.js';

const app = createApp();
let auth: { Authorization: string };

beforeEach(async () => {
  resetDbForTests();
  const res = await loginForTest(app, {
    userId: 'gerente-loja-admin',
    companyId: 'loja-admin',
    profileCodes: ['gerente_loja'],
  });
  auth = { Authorization: `Bearer ${res.body.accessToken}` };
});

async function produto(nome: string, publicado: boolean) {
  const p = await request(app)
    .post('/api/v1/core/products')
    .set(auth)
    .send({ name: nome, priceCents: 12000, publishOnline: publicado });
  return p.body.id as string;
}

async function salvar(body: Record<string, unknown>) {
  return request(app).put('/api/v1/core/storefront/settings').set(auth).send(body);
}

describe('identidade da loja', () => {
  it('nasce vazia, sem inventar texto', async () => {
    const res = await request(app).get('/api/v1/core/storefront/settings').set(auth);
    expect(res.status).toBe(200);
    // Texto genérico inventado é pior que ausência: parece configurado.
    expect(res.body.settings.headline).toBeNull();
    expect(res.body.settings.banner_active).toBe(0);
  });

  it('o que o gestor escreve CHEGA na vitrine', async () => {
    await salvar({
      headline: 'Moda feminina em Pelotas',
      description: 'Peças novas toda semana',
      whatsapp: '53999990000',
    });

    // A rota pública, que é o que o cliente vê.
    const publica = await request(app).get('/api/v1/loja/stores');
    const loja = [...publica.body.stores, ...publica.body.services].find(
      (s: { slug: string }) => s.slug === 'loja-admin',
    );
    expect(loja.headline).toBe('Moda feminina em Pelotas');
    expect(loja.description).toBe('Peças novas toda semana');
  });

  it('faixa DESLIGADA não chega ao cliente', async () => {
    await salvar({ bannerText: 'Frete grátis hoje', bannerActive: false });

    const publica = await request(app).get('/api/v1/loja/stores');
    const loja = [...publica.body.stores, ...publica.body.services].find(
      (s: { slug: string }) => s.slug === 'loja-admin',
    );
    // Guardar o texto e não mostrar é o esperado: o gestor escreve hoje e liga
    // no dia da promoção.
    expect(loja.bannerText).toBeNull();
  });

  it('faixa ligada chega', async () => {
    await salvar({ bannerText: 'Frete grátis hoje', bannerActive: true });
    const publica = await request(app).get('/api/v1/loja/stores');
    const loja = [...publica.body.stores, ...publica.body.services].find(
      (s: { slug: string }) => s.slug === 'loja-admin',
    );
    expect(loja.bannerText).toBe('Frete grátis hoje');
  });

  it('texto em branco volta a ser ausência, não string vazia', async () => {
    await salvar({ headline: 'Algo' });
    await salvar({ headline: '   ' });
    const res = await request(app).get('/api/v1/core/storefront/settings').set(auth);
    expect(res.body.settings.headline).toBeNull();
  });
});

describe('destaque não cria catálogo paralelo', () => {
  it('destacar exige estar publicado', async () => {
    const p = await produto('Não publicado', false);
    const res = await request(app)
      .post(`/api/v1/core/storefront/featured/${p}`)
      .set(auth)
      .send({ featured: true });

    // Destacado sem estar publicado apareceria na régua e sumiria ao clicar.
    expect(res.status).toBe(409);
  });

  it('publicado pode ser destacado', async () => {
    const p = await produto('Publicado', true);
    const res = await request(app)
      .post(`/api/v1/core/storefront/featured/${p}`)
      .set(auth)
      .send({ featured: true });
    expect(res.body.featured_online).toBe(1);
  });

  it('a lista da administração só traz publicados', async () => {
    await produto('Publicado', true);
    await produto('Só no balcão', false);

    const res = await request(app).get('/api/v1/core/storefront/settings').set(auth);
    expect(res.body.products).toHaveLength(1);
    expect(res.body.products[0].name).toBe('Publicado');
  });

  it('o destaque mora no produto — não há lista separada para divergir', async () => {
    const p = await produto('Destaque', true);
    await request(app)
      .post(`/api/v1/core/storefront/featured/${p}`)
      .set(auth)
      .send({ featured: true });

    const res = await request(app).get('/api/v1/core/storefront/settings').set(auth);
    const item = res.body.products.find((x: { id: string }) => x.id === p);
    expect(item.featured_online).toBe(1);
  });
});

describe('isolamento', () => {
  it('a identidade é por operação', async () => {
    await salvar({ headline: 'Da primeira loja' });

    const outra = await loginForTest(app, {
      userId: 'gerente-vizinha-loja',
      companyId: 'loja-vizinha-admin',
      profileCodes: ['gerente_loja'],
    });
    const res = await request(app)
      .get('/api/v1/core/storefront/settings')
      .set({ Authorization: `Bearer ${outra.body.accessToken}` });

    // Seis lojas do grupo, seis identidades.
    expect(res.body.settings.headline).toBeNull();
  });
});
