/**
 * As duas oficinas do grupo trabalham diferente.
 *
 *   MOBILIDADE (Oficina)     moto, bike e patinete ficam dias no pátio. A
 *                            PLAQUINHA é como se acha o aparelho e como o
 *                            cliente consulta o andamento.
 *   CELULARES (Preço Justo)  o aparelho entra e sai, muitas vezes no mesmo dia,
 *                            e vai para gaveta identificada pela própria OS.
 *                            Plaquinha com QR colada no celular do cliente não
 *                            serve — e oferecer o botão ensina a usar o que não
 *                            se usa.
 *
 * As duas têm kanban e estoque de peças: é o trabalho comum de bancada.
 *
 * A segunda regra: PERTENCER À EMPRESA NÃO BASTA. Quem conserta celular não
 * ganha a bancada de mobilidade por estar na mesma operação — o vínculo é com a
 * oficina.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { resetDbForTests } from '../src/db/database.js';
import { getConnection } from '../src/db/sqlite.js';
import { loginForTest } from './helpers/auth.js';
import { capabilitiesFor } from '../src/services/core/WorkshopCapabilities.js';

const app = createApp();
let auth: { Authorization: string };
let companyId: string;
let mobilidade: string;
let celulares: string;

beforeEach(async () => {
  resetDbForTests();
  const res = await loginForTest(app, {
    userId: 'ger-of-regras',
    companyId: 'empresa-oficinas',
    profileCodes: ['gerente_oficina'],
  });
  auth = { Authorization: `Bearer ${res.body.accessToken}` };
  companyId = res.body.company.id;

  const db = getConnection();
  const agora = new Date().toISOString();
  mobilidade = 'wk-mob';
  celulares = 'wk-cel';
  db.prepare(
    `INSERT INTO core_workshops (id, company_id, slug, name, kind, active, created_at)
     VALUES (?, ?, 'mob', 'Oficina de Mobilidade', 'mobility', 1, ?)`,
  ).run(mobilidade, companyId, agora);
  db.prepare(
    `INSERT INTO core_workshops (id, company_id, slug, name, kind, active, created_at)
     VALUES (?, ?, 'cel', 'Oficina de Celulares', 'phones', 1, ?)`,
  ).run(celulares, companyId, agora);
});

/** Equipamento externo exige dono desde o início — é do cliente. */
async function equipamento(workshopId: string, nome: string) {
  const cliente = await request(app)
    .post('/api/v1/core/customers')
    .set(auth)
    .send({ name: `Dono de ${nome}` });

  const res = await request(app)
    .post('/api/v1/core/equipment')
    .set(auth)
    .send({
      workshopId,
      brand: 'Marca',
      model: nome,
      origin: 'EXTERNAL_CUSTOMER',
      ownerCustomerId: cliente.body.id,
    });
  expect(res.status).toBeLessThan(300);
  return res.body.id as string;
}

describe('a regra mora num lugar só', () => {
  it('mobilidade usa plaquinha; celulares não', () => {
    expect(capabilitiesFor('mobility').equipmentTags).toBe(true);
    expect(capabilitiesFor('phones').equipmentTags).toBe(false);
  });

  it('as duas têm kanban e peças — é o trabalho comum de bancada', () => {
    for (const tipo of ['mobility', 'phones']) {
      expect(capabilitiesFor(tipo).kanban).toBe(true);
      expect(capabilitiesFor(tipo).parts).toBe(true);
    }
  });

  it('tipo desconhecido cai no conjunto restrito — não se libera por omissão', () => {
    expect(capabilitiesFor('nova-modalidade').equipmentTags).toBe(false);
  });
});

describe('plaquinha só onde o aparelho fica', () => {
  it('a Oficina de Mobilidade emite', async () => {
    const eq = await equipamento(mobilidade, 'Patinete');
    const res = await request(app)
      .post('/api/v1/core/labels/equipment')
      .set(auth)
      .send({ equipmentIds: [eq], baseUrl: 'http://loja' });

    expect(res.status).toBe(200);
    expect(res.body.items[0].qrUrl).toContain('/equipamento/');
  });

  it('a Oficina de Celulares NÃO emite, e diz por quê', async () => {
    const eq = await equipamento(celulares, 'Celular');
    const res = await request(app)
      .post('/api/v1/core/labels/equipment')
      .set(auth)
      .send({ equipmentIds: [eq], baseUrl: 'http://loja' });

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('CORE_WORKSHOP_NO_TAGS');
    // A mensagem explica em vez de só recusar.
    expect(res.body.error.message).toContain('OS');
  });

  it('a recusa vale mesmo no meio de um lote', async () => {
    const bom = await equipamento(mobilidade, 'Bike');
    const proibido = await equipamento(celulares, 'Celular');
    const res = await request(app)
      .post('/api/v1/core/labels/equipment')
      .set(auth)
      .send({ equipmentIds: [bom, proibido], baseUrl: 'http://loja' });
    // Emitir o lote pela metade deixaria plaquinha impressa sem par.
    expect(res.status).toBe(409);
  });
});

describe('as capacidades chegam à tela', () => {
  it('a listagem diz o que cada oficina faz', async () => {
    const res = await request(app).get('/api/v1/core/workshops').set(auth);
    const mob = res.body.items.find((w: { id: string }) => w.id === mobilidade);
    const cel = res.body.items.find((w: { id: string }) => w.id === celulares);

    // Sem isto a tela teria de repetir a regra, e as duas divergiriam.
    expect(mob.capabilities.equipmentTags).toBe(true);
    expect(cel.capabilities.equipmentTags).toBe(false);
  });
});

describe('pertencer à empresa não basta', () => {
  async function pessoa(login: string) {
    const res = await loginForTest(app, {
      userId: login,
      companyId: 'empresa-oficinas',
      profileCodes: ['mecanico'],
    });
    return res.body.user.id as string;
  }

  it('incluir na bancada e listar', async () => {
    const mec = await pessoa('mec-mob');
    const add = await request(app)
      .post(`/api/v1/core/workshops/${mobilidade}/members`)
      .set(auth)
      .send({ userId: mec });
    expect(add.status).toBe(201);

    const lista = await request(app)
      .get(`/api/v1/core/workshops/${mobilidade}/members`)
      .set(auth);
    expect(lista.body.items).toHaveLength(1);
  });

  it('estar numa bancada não põe na outra', async () => {
    const mec = await pessoa('mec-cel');
    await request(app)
      .post(`/api/v1/core/workshops/${celulares}/members`)
      .set(auth)
      .send({ userId: mec });

    const outra = await request(app)
      .get(`/api/v1/core/workshops/${mobilidade}/members`)
      .set(auth);
    // É a regra que o próprio schema já declarava e ninguém podia exercer.
    expect(outra.body.items).toHaveLength(0);
  });

  it('quem não é da operação não entra na bancada', async () => {
    const outraEmpresa = await loginForTest(app, {
      userId: 'mec-de-fora',
      companyId: 'outra-empresa',
      profileCodes: ['mecanico'],
    });
    const res = await request(app)
      .post(`/api/v1/core/workshops/${mobilidade}/members`)
      .set(auth)
      .send({ userId: outraEmpresa.body.user.id });
    expect(res.status).toBe(404);
  });

  it('incluir duas vezes não duplica', async () => {
    const mec = await pessoa('mec-dup');
    await request(app)
      .post(`/api/v1/core/workshops/${mobilidade}/members`)
      .set(auth)
      .send({ userId: mec });
    const segunda = await request(app)
      .post(`/api/v1/core/workshops/${mobilidade}/members`)
      .set(auth)
      .send({ userId: mec });

    // Já estar na bancada não é erro: é o resultado desejado.
    expect(segunda.body.alreadyMember).toBe(true);
    const lista = await request(app)
      .get(`/api/v1/core/workshops/${mobilidade}/members`)
      .set(auth);
    expect(lista.body.items).toHaveLength(1);
  });

  it('remover tira só daquela bancada', async () => {
    const mec = await pessoa('mec-duplo');
    await request(app)
      .post(`/api/v1/core/workshops/${mobilidade}/members`)
      .set(auth)
      .send({ userId: mec });
    await request(app)
      .post(`/api/v1/core/workshops/${celulares}/members`)
      .set(auth)
      .send({ userId: mec });

    await request(app)
      .delete(`/api/v1/core/workshops/${mobilidade}/members/${mec}`)
      .set(auth);

    const mob = await request(app).get(`/api/v1/core/workshops/${mobilidade}/members`).set(auth);
    const cel = await request(app).get(`/api/v1/core/workshops/${celulares}/members`).set(auth);
    expect(mob.body.items).toHaveLength(0);
    expect(cel.body.items).toHaveLength(1);
  });
});
