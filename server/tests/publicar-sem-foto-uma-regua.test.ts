/**
 * PRODUTO SEM FOTO: UMA RÉGUA SÓ (GAP-PRD-207).
 *
 * O DEFEITO: o PUT do produto aceitava publicar sem foto (200), a vitrine
 * listava o produto com o "FOTO EM BREVE", e a régua de prontidão dizia que
 * ele estava BLOQUEADO (`blockers: ['sem_foto']`, `ready: false`). Duas
 * verdades sobre o mesmo produto — e a tela de prontidão contava como
 * "com pendência" um item que estava vendendo.
 *
 * A DECISÃO: a vitrine foi desenhada para mostrar produto sem foto (o marcador
 * "Foto em breve" existe de propósito) e o cadastro publica antes da foto
 * existir — a foto só sobe depois que o produto tem id. Então sem foto NÃO é
 * bloqueio: é AVISO. A prontidão passa a dizer isso (`warnings`), o produto
 * publicado sem foto conta como vendendo, e a publicação em massa — que é a
 * única que decide por muitos de uma vez — só inclui os sem foto quando o
 * gestor pede com todas as letras (`incluirSemFoto`).
 */
import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { resetDbForTests } from '../src/db/database.js';
import { getConnection } from '../src/db/sqlite.js';
import { loginForTest } from './helpers/auth.js';

const app = createApp();
let auth: { Authorization: string };

/** Produto completo — preço, medidas e saldo — com ou sem foto. */
async function produto(nome: string, opcoes: { foto: boolean; publicado: boolean }): Promise<string> {
  const criado = await request(app)
    .post('/api/v1/core/products')
    .set(auth)
    .send({ name: nome, priceCents: 15000, category: 'Geral', publishOnline: false });
  expect(criado.status).toBe(201);
  const id = String(criado.body.id);
  const db = getConnection();
  db.prepare(
    'UPDATE core_products SET weight_grams = 500, height_cm = 10, width_cm = 20, length_cm = 30 WHERE id = ?',
  ).run(id);
  await request(app).post('/api/v1/core/stock/movements').set(auth).send({
    productId: id,
    movementType: 'in',
    quantity: 4,
    referenceType: 'entrada',
    referenceId: `nf-${id}`,
  });
  if (opcoes.foto) {
    db.prepare(
      `INSERT INTO core_product_images (id, product_id, company_id, url, is_primary, position, created_at)
       VALUES (?, ?, 'gringa', ?, 1, 0, ?)`,
    ).run(`img-${id}`, id, `/uploads/${id}.jpg`, new Date().toISOString());
    db.prepare('UPDATE core_products SET image_url = ? WHERE id = ?').run(`/uploads/${id}.jpg`, id);
  }
  if (opcoes.publicado) {
    const pub = await request(app)
      .put(`/api/v1/core/products/${id}`)
      .set(auth)
      .send({ name: nome, publishOnline: true });
    expect(pub.status).toBe(200);
  }
  return id;
}

async function prontidao(id: string) {
  const res = await request(app).get('/api/v1/core/products/prontidao-online').set(auth);
  expect(res.status).toBe(200);
  return res.body.items.find((l: { id: string }) => l.id === id) as {
    blockers: string[];
    warnings: string[];
    ready: boolean;
    readyToPublish: boolean;
    publishOnline: boolean;
  };
}

beforeEach(async () => {
  resetDbForTests();
  const login = await loginForTest(app, {
    userId: 'ger-gringa',
    companyId: 'gringa',
    profileCodes: ['gerente_loja'],
  });
  auth = { Authorization: `Bearer ${login.body.accessToken}` };
});

describe('o que o PUT publica, a prontidão não chama de bloqueio', () => {
  it('publicado sem foto: aparece na vitrine, e a prontidão diz VENDENDO com aviso', async () => {
    const id = await produto('Tênis Sem Foto', { foto: false, publicado: true });

    const vitrine = await request(app).get('/api/v1/loja/products');
    const card = vitrine.body.items.find((p: { id: string }) => p.id === id);
    expect(card).toBeTruthy();
    expect(card.imageUrl).toBeNull();

    const linha = await prontidao(id);
    expect(linha.blockers).not.toContain('sem_foto');
    expect(linha.warnings).toEqual(['sem_foto']);
    expect(linha.ready).toBe(true);
  });

  it('com foto não há aviso nenhum', async () => {
    const id = await produto('Tênis Com Foto', { foto: true, publicado: true });
    const linha = await prontidao(id);
    expect(linha.warnings).toEqual([]);
    expect(linha.ready).toBe(true);
  });

  it('não publicado e sem foto: pronto para publicar, com o aviso junto', async () => {
    const id = await produto('Bota Sem Foto', { foto: false, publicado: false });
    const linha = await prontidao(id);
    expect(linha.readyToPublish).toBe(true);
    expect(linha.blockers).toEqual(['nao_publicado']);
    expect(linha.warnings).toEqual(['sem_foto']);
  });
});

describe('a publicação em massa só leva os sem foto quando pedida', () => {
  it('sem o pedido, publica os completos e conta os sem foto à parte', async () => {
    const completo = await produto('Jaqueta Completa', { foto: true, publicado: false });
    const semFoto = await produto('Jaqueta Sem Foto', { foto: false, publicado: false });

    const res = await request(app).post('/api/v1/core/products/publicar-prontos').set(auth).send({});
    expect(res.status).toBe(200);
    expect(res.body.published).toEqual([completo]);
    expect(res.body.semFoto).toBe(1);
    expect((await prontidao(semFoto)).publishOnline).toBe(false);
  });

  it('com incluirSemFoto, publica também os sem foto — e a trilha registra a escolha', async () => {
    const semFoto = await produto('Boné Sem Foto', { foto: false, publicado: false });

    const res = await request(app)
      .post('/api/v1/core/products/publicar-prontos')
      .set(auth)
      .send({ incluirSemFoto: true });
    expect(res.status).toBe(200);
    expect(res.body.published).toEqual([semFoto]);
    expect((await prontidao(semFoto)).publishOnline).toBe(true);

    const trilha = getConnection()
      .prepare("SELECT detail FROM core_audit_log WHERE action = 'product.publish_ready' ORDER BY created_at DESC LIMIT 1")
      .get() as { detail: string };
    expect(JSON.parse(trilha.detail).incluirSemFoto).toBe(true);
  });
});
