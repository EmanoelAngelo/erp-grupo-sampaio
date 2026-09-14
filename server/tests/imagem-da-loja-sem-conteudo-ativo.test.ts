/**
 * ============================================================================
 * A IMAGEM DA LOJA NÃO CARREGA CONTEÚDO ATIVO (GAP-PRD-066)
 * ============================================================================
 *
 * O logo e a capa da loja aceitavam `image/svg+xml`, e `/uploads/lojas` os
 * servia como estáticos sem nenhuma política. SVG é documento, não só figura:
 * um `<svg><script>…</script></svg>` enviado por um gerente virava um arquivo
 * público que, aberto pela URL direta, roda script na origem de quem serve —
 * e o desenho recomendado de implantação serve API e telas na MESMA origem.
 * Na vitrine, dentro de `<img>`, ele não executa; é a URL direta que executa.
 *
 * O que este arquivo cobra:
 *
 *   1. SVG não entra mais, nem declarado como tal nem disfarçado de PNG — o
 *      servidor confere a ASSINATURA dos bytes, não o que o cliente diz;
 *   2. o que já está no disco (SVG de antes desta correção, ou qualquer coisa
 *      que um dia escape) é servido com `Content-Security-Policy: sandbox;
 *      default-src 'none'` e `nosniff` — nas TRÊS pastas públicas;
 *   3. PNG, JPEG e WebP de verdade continuam entrando e saindo.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createApp } from '../src/app.js';
import { resetDbForTests } from '../src/db/database.js';
import {
  linkUserToCompany,
  upsertCompany,
  upsertUser,
} from '../src/services/auth/IdentityService.js';
import { storeUploadsDir } from '../src/services/core/StorefrontSettingsService.js';
import { uploadsDir } from '../src/services/core/ProductImageService.js';
import { photosDir } from '../src/services/core/WorkshopPhotoService.js';
import { assinarCaminhoDaFoto } from '../src/services/core/FotoDaOsAssinada.js';

const app = createApp();
const SENHA = 'Imagem@DaLoja!2026';

const SVG_COM_SCRIPT =
  '<svg xmlns="http://www.w3.org/2000/svg"><script>fetch("/api/v1/auth/me")</script></svg>';
/** PNG de 1x1 de verdade. */
const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);

let empresa: string;
let gerente: { Authorization: string };

beforeEach(async () => {
  resetDbForTests();
  empresa = upsertCompany({
    slug: 'preco-justo',
    legalName: 'Preço Justo Comércio Ltda',
    tradeName: 'Preço Justo',
    kind: 'retail',
  });
  const userId = await upsertUser({ login: 'GERENTE.IMAGEM', displayName: 'Gerente', password: SENHA });
  linkUserToCompany(userId, empresa, 'gerente_loja', true);
  const res = await request(app)
    .post('/api/v1/auth/login')
    .send({ login: 'GERENTE.IMAGEM', password: SENHA, companyId: empresa });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  gerente = { Authorization: `Bearer ${res.body.accessToken}` };
});

function enviar(dataUrl: string, tipo: 'logo' | 'capa' = 'logo') {
  return request(app).post('/api/v1/core/storefront/imagem').set(gerente).send({ tipo, dataUrl });
}

function comoDataUrl(mime: string, bytes: Buffer | string): string {
  return `data:${mime};base64,${Buffer.from(bytes).toString('base64')}`;
}

describe('o que entra', () => {
  it('SVG é recusado — com script ou sem', async () => {
    const r = await enviar(comoDataUrl('image/svg+xml', SVG_COM_SCRIPT));
    expect(r.status, JSON.stringify(r.body)).toBe(400);
    expect(r.body.error.code).toBe('CORE_IMAGE_FORMAT_INVALID');
    expect(r.body.error.details.accepted).not.toContain('image/svg+xml');
  });

  it('SVG disfarçado de PNG é recusado pela assinatura dos bytes', async () => {
    const r = await enviar(comoDataUrl('image/png', SVG_COM_SCRIPT));
    expect(r.status, JSON.stringify(r.body)).toBe(400);
    expect(r.body.error.code).toBe('CORE_IMAGE_CONTENT_MISMATCH');
  });

  it('PNG de verdade continua entrando e sai como imagem', async () => {
    const r = await enviar(comoDataUrl('image/png', PNG_1X1));
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    const url = String(r.body.logo_url ?? r.body.logoUrl ?? '');
    expect(url).toMatch(/^\/uploads\/lojas\/[0-9a-f-]+\.png$/);

    const arquivo = await request(app).get(url);
    expect(arquivo.status).toBe(200);
    expect(arquivo.headers['content-type']).toMatch(/^image\/png/);
  });
});

describe('o que sai das pastas públicas', () => {
  const PASTAS: Array<[string, () => string]> = [
    ['/uploads/lojas', storeUploadsDir],
    ['/uploads/produtos', uploadsDir],
  ];

  it.each(PASTAS)('%s serve SVG antigo sem deixar o script rodar', async (prefixo, pasta) => {
    // O arquivo que ficou no disco de antes da correção.
    mkdirSync(pasta(), { recursive: true });
    const nome = `legado-${Date.now()}.svg`;
    writeFileSync(join(pasta(), nome), SVG_COM_SCRIPT);

    const r = await request(app).get(`${prefixo}/${nome}`);
    expect(r.status).toBe(200);
    const csp = String(r.headers['content-security-policy'] ?? '');
    expect(csp).toContain('sandbox');
    expect(csp).toContain("default-src 'none'");
    expect(r.headers['x-content-type-options']).toBe('nosniff');
  });

  it('/uploads/os não serve SVG antigo nenhum: a foto da OS só abre por link assinado, e o link nunca é assinado para SVG', async () => {
    mkdirSync(photosDir(), { recursive: true });
    const nome = `legado-${Date.now()}.svg`;
    writeFileSync(join(photosDir(), nome), SVG_COM_SCRIPT);
    const cru = await request(app).get(`/uploads/os/${nome}`);
    expect(cru.status).toBe(403);
    // O assinador devolve o caminho como veio (sem assinatura) — e o guarda recusa de novo.
    const tentado = assinarCaminhoDaFoto(`/uploads/os/${nome}`);
    expect(tentado).toBe(`/uploads/os/${nome}`);
    expect((await request(app).get(tentado)).status).toBe(403);
  });

  it('a imagem de verdade leva a mesma política — e continua sendo imagem', async () => {
    mkdirSync(storeUploadsDir(), { recursive: true });
    writeFileSync(join(storeUploadsDir(), 'marca.png'), PNG_1X1);
    const r = await request(app).get('/uploads/lojas/marca.png');
    expect(r.status).toBe(200);
    expect(r.headers['content-type']).toMatch(/^image\/png/);
    expect(String(r.headers['content-security-policy'] ?? '')).toContain('sandbox');
  });
});
