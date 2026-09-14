/**
 * A IDENTIDADE VISUAL da loja — logo e capa, controlados pelo gestor (rodada 40).
 *
 * A paleta de cada marca é código (aprovada pelo dono a partir dos logos); o
 * que o gestor controla pelo painel é a IMAGEM. O desenho é o mesmo das fotos
 * de produto: arquivo no disco, URL no banco, nunca base64 em coluna — e o
 * nome no disco é gerado, para nome vindo do cliente nunca decidir caminho.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { existsSync, readdirSync } from 'node:fs';
import { createApp } from '../src/app.js';
import { resetDbForTests } from '../src/db/database.js';
import { storeUploadsDir } from '../src/services/core/StorefrontSettingsService.js';
import { loginForTest } from './helpers/auth.js';

const app = createApp();
let auth: { Authorization: string };

// PNG 1×1 válido, minúsculo — o suficiente para o caminho inteiro.
const PNG_1PX =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

beforeEach(async () => {
  resetDbForTests();
  const login = await loginForTest(app, {
    userId: 'ger',
    companyId: 'gringa',
    profileCodes: ['gerente_loja'],
  });
  auth = { Authorization: `Bearer ${login.body.accessToken}` };
});

describe('logo e capa da loja', () => {
  it('o gestor envia o logo, a URL aparece em /loja/stores, e o arquivo existe no disco', async () => {
    const envio = await request(app)
      .post('/api/v1/core/storefront/imagem')
      .set(auth)
      .send({ tipo: 'logo', dataUrl: PNG_1PX });
    expect(envio.status).toBe(201);
    expect(envio.body.logo_url).toMatch(/^\/uploads\/lojas\/[0-9a-f-]+\.png$/);

    // O arquivo está no disco com o nome gerado.
    const nome = envio.body.logo_url.split('/').pop()!;
    expect(existsSync(`${storeUploadsDir()}/${nome}`)).toBe(true);

    // E a vitrine pública passa a receber a URL.
    const lojas = await request(app).get('/api/v1/loja/stores');
    const gringa = lojas.body.stores.find((s: { slug: string }) => s.slug === 'gringa');
    expect(gringa.logoUrl).toBe(envio.body.logo_url);
  });

  it('trocar o logo remove o arquivo antigo do disco', async () => {
    const um = await request(app)
      .post('/api/v1/core/storefront/imagem')
      .set(auth)
      .send({ tipo: 'logo', dataUrl: PNG_1PX });
    const nomeUm = um.body.logo_url.split('/').pop()!;

    const dois = await request(app)
      .post('/api/v1/core/storefront/imagem')
      .set(auth)
      .send({ tipo: 'logo', dataUrl: PNG_1PX });
    const nomeDois = dois.body.logo_url.split('/').pop()!;

    expect(nomeUm).not.toBe(nomeDois);
    expect(existsSync(`${storeUploadsDir()}/${nomeUm}`)).toBe(false);
    expect(existsSync(`${storeUploadsDir()}/${nomeDois}`)).toBe(true);
  });

  it('a capa é independente do logo', async () => {
    await request(app)
      .post('/api/v1/core/storefront/imagem')
      .set(auth)
      .send({ tipo: 'capa', dataUrl: PNG_1PX });
    const lojas = await request(app).get('/api/v1/loja/stores');
    const gringa = lojas.body.stores.find((s: { slug: string }) => s.slug === 'gringa');
    expect(gringa.coverUrl).toMatch(/^\/uploads\/lojas\//);
    expect(gringa.logoUrl).toBeNull();
  });

  it('remover apaga a URL e o arquivo', async () => {
    const envio = await request(app)
      .post('/api/v1/core/storefront/imagem')
      .set(auth)
      .send({ tipo: 'logo', dataUrl: PNG_1PX });
    const nome = envio.body.logo_url.split('/').pop()!;

    const remocao = await request(app).delete('/api/v1/core/storefront/imagem/logo').set(auth);
    expect(remocao.status).toBe(200);
    expect(remocao.body.logo_url).toBeNull();
    expect(existsSync(`${storeUploadsDir()}/${nome}`)).toBe(false);
  });

  it('recusa o que não é imagem, sem gravar nada', async () => {
    const antes = existsSync(storeUploadsDir()) ? readdirSync(storeUploadsDir()).length : 0;
    const res = await request(app)
      .post('/api/v1/core/storefront/imagem')
      .set(auth)
      .send({ tipo: 'logo', dataUrl: 'data:text/html;base64,PGh0bWw+' });
    expect(res.status).toBe(400);
    const depois = existsSync(storeUploadsDir()) ? readdirSync(storeUploadsDir()).length : 0;
    expect(depois).toBe(antes);
  });

  it('atendente não mexe na identidade da loja', async () => {
    const login = await loginForTest(app, {
      userId: 'atd',
      companyId: 'gringa',
      profileCodes: ['atendente'],
    });
    const res = await request(app)
      .post('/api/v1/core/storefront/imagem')
      .set({ Authorization: `Bearer ${login.body.accessToken}` })
      .send({ tipo: 'logo', dataUrl: PNG_1PX });
    expect(res.status).toBe(403);
  });
});
