/**
 * A FOTO DA OS NÃO É PÚBLICA — GAP-PRD-184.
 *
 * `/uploads/os/<uuid>.<ext>` era servido sem sessão, para sempre: o aparelho
 * do cliente ficava a um link encaminhado de qualquer pessoa. Agora o caminho
 * cru é recusado; quem entrega o link é a listagem da OS (sessão + alcance),
 * com assinatura de uma hora. Os casos cobram o link que abre, o que não abre
 * (sem assinatura, adulterado, de outra foto, vencido) e o cache privado.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Express } from 'express';
import { resetDbForTests } from '../src/db/database.js';
import { getConnection } from '../src/db/sqlite.js';
import { assinarCaminhoDaFoto, VALIDADE_DO_LINK_MS } from '../src/services/core/FotoDaOsAssinada.js';
import { loginForTest } from './helpers/auth.js';

const PNG_1X1 =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

let app: Express;
let pasta: string;
let gerente: { Authorization: string };

beforeAll(async () => {
  // A pasta vem ANTES do app: o `express.static` fixa a raiz ao montar.
  pasta = mkdtempSync(join(tmpdir(), 'gs-fotos-assinadas-'));
  process.env.DEVORA_UPLOADS_DIR = pasta;
  const { createApp } = await import('../src/app.js');
  app = createApp();
});

afterAll(() => {
  delete process.env.DEVORA_UPLOADS_DIR;
  rmSync(pasta, { recursive: true, force: true });
});

beforeEach(async () => {
  resetDbForTests();
  const login = await loginForTest(app, {
    userId: 'gerente-fotos',
    companyId: 'oficina-fotos',
    profileCodes: ['gerente_oficina'],
  });
  gerente = { Authorization: `Bearer ${login.body.accessToken}` };
  getConnection()
    .prepare(
      `INSERT INTO core_workshops (id, company_id, slug, name, kind, active, created_at)
       VALUES ('ws-f', 'oficina-fotos', 'slug-ws-f', 'Bancada F', 'mobility', 1, ?)`,
    )
    .run(new Date().toISOString());
});

async function osComFotos(quantas = 1): Promise<{ osId: string; caminhos: string[] }> {
  const os = await request(app)
    .post('/api/v1/core/workshop/orders?workshopId=ws-f')
    .set(gerente)
    .send({ customerName: 'Cliente da Tela', complaint: 'Tela trincada' });
  expect(os.status, JSON.stringify(os.body)).toBe(201);
  const caminhos: string[] = [];
  for (let i = 0; i < quantas; i += 1) {
    const foto = await request(app)
      .post(`/api/v1/core/workshop/orders/${os.body.id}/photos`)
      .set(gerente)
      .send({ dataUrl: PNG_1X1, kind: 'entrada' });
    expect(foto.status, JSON.stringify(foto.body)).toBe(201);
    caminhos.push(String(foto.body.url).split('?')[0]);
  }
  return { osId: String(os.body.id), caminhos };
}

async function linksDaListagem(osId: string): Promise<string[]> {
  const res = await request(app).get(`/api/v1/core/workshop/orders/${osId}/photos`).set(gerente);
  expect(res.status).toBe(200);
  return (res.body.items as { url: string }[]).map((f) => f.url);
}

describe('o caminho cru não abre mais', () => {
  it('GET /uploads/os/<arquivo> sem assinatura é 403 — não 200', async () => {
    const { caminhos } = await osComFotos();
    const res = await request(app).get(caminhos[0]);
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('CORE_PHOTO_LINK_INVALID');
  });

  it('a listagem continua exigindo sessão (401 sem token)', async () => {
    const { osId } = await osComFotos();
    const res = await request(app).get(`/api/v1/core/workshop/orders/${osId}/photos`);
    expect(res.status).toBe(401);
  });
});

describe('o link da listagem abre, por uma hora, e só aquela foto', () => {
  it('a listagem entrega o link assinado, e ele abre a imagem com cache privado', async () => {
    const { osId } = await osComFotos();
    const [link] = await linksDaListagem(osId);
    expect(link).toMatch(/^\/uploads\/os\/[0-9a-f-]{36}\.png\?e=\d+&s=[A-Za-z0-9_-]+$/);

    const expiraEm = Number(new URL(link, 'http://x').searchParams.get('e')) * 1000;
    expect(expiraEm - Date.now()).toBeLessThanOrEqual(VALIDADE_DO_LINK_MS + 1000);
    expect(expiraEm - Date.now()).toBeGreaterThan(VALIDADE_DO_LINK_MS - 60_000);

    const res = await request(app).get(link);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/image\/png/);
    expect(res.headers['cache-control']).toMatch(/^private, max-age=\d+$/);
  });

  it('assinatura adulterada é 403', async () => {
    const { osId } = await osComFotos();
    const [link] = await linksDaListagem(osId);
    const ultimo = link.slice(-1);
    const adulterado = link.slice(0, -1) + (ultimo === 'A' ? 'B' : 'A');
    const res = await request(app).get(adulterado);
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('CORE_PHOTO_LINK_INVALID');
  });

  it('a assinatura de uma foto não abre outra', async () => {
    const { osId } = await osComFotos(2);
    const [a, b] = await linksDaListagem(osId);
    const consultaDeA = a.slice(a.indexOf('?'));
    const caminhoDeB = b.slice(0, b.indexOf('?'));
    const res = await request(app).get(caminhoDeB + consultaDeA);
    expect(res.status).toBe(403);
  });

  it('link legítimo que passou da hora é 403 CORE_PHOTO_LINK_EXPIRED', async () => {
    const { caminhos } = await osComFotos();
    const vencido = assinarCaminhoDaFoto(caminhos[0], new Date(Date.now() - 2 * VALIDADE_DO_LINK_MS));
    const res = await request(app).get(vencido);
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('CORE_PHOTO_LINK_EXPIRED');
  });

  it('caminho que tenta sair da pasta não passa nem pela conferência', async () => {
    const res = await request(app).get('/uploads/os/..%2F..%2Fgrupo-sampaio.db?e=9999999999&s=x');
    expect(res.status).toBe(403);
  });
});
