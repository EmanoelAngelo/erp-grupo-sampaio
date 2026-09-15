/**
 * ============================================================================
 * PLAQUINHA SÓ NA PJ MOTORS (P0 das plaquinhas)
 * ============================================================================
 *
 * ## A regra do dono
 *
 * Plaquinha com QR e número existe SÓ na PJ Motors (slug `pj-motors`) — por
 * código, API, menu, permissão e teste. Não na Preço Justo, não na Oficina, não
 * na Gringa, na Me Mimei nem na Conceito.
 *
 * ## O defeito que isto cerca
 *
 *   - a regra antiga era "PJ Motors e Oficina", e a subida do servidor marcava
 *     a Oficina a cada boot;
 *   - as LEITURAS do pool (lista, lotes, layout, formatos) não perguntavam
 *     nada: respondiam 200 com a lista para qualquer empresa;
 *   - a folha e a etiqueta por máquina (`/labels/equipment*`) só olhavam a
 *     bancada — a Oficina imprimia plaquinha por ali;
 *   - desvincular a unidade e escolher o adesivo do pool no cadastro da máquina
 *     não passavam pela regra.
 *
 * ## O que este arquivo prova
 *
 *   1. cada rota de plaquinha recusa (403 `CORE_COMPANY_NO_TAGS`) a Preço
 *      Justo, a Oficina e outra loja — MESMO com a marca ligada no cadastro,
 *      como um banco antigo pode ter — e a recusa não carrega número, token ou
 *      máquina de ninguém;
 *   2. as mesmas rotas atendem a PJ Motors — sem bancada, que ela não tem e
 *      não precisa ter desde a decisão do dono —, e o que a PJ lê é só dela;
 *   3. a migração marca SÓ a PJ, é idempotente e não apaga nada: a plaquinha
 *      que a Oficina já tinha continua no banco, inalcançável.
 *
 * As mordidas: tire `exigirEmpresaComPlaquinha` de qualquer rota da lista e o
 * caso 1 fica vermelho para ela; tire o slug de `empresaUsaPlaquinha` e o
 * caso 1 fica vermelho para as três empresas de uma vez.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import { createApp } from '../src/app.js';
import { getConnection } from '../src/db/sqlite.js';
import { resetDbForTests } from '../src/db/database.js';
import { ensureOfficialTagCompanies, ensureOfficialWorkshops } from '../src/db/core-migrations.js';
import { upsertCompany } from '../src/services/auth/IdentityService.js';
import { createProduct, updateProduct } from '../src/services/core/CatalogService.js';
import { applyMovement } from '../src/services/core/InventoryService.js';
import { createUnits } from '../src/services/core/ProductUnitService.js';
import { createEquipment } from '../src/services/core/EquipmentService.js';
import { vincularUnidade } from '../src/services/core/EquipmentStockLink.js';
import { empresaUsaPlaquinha } from '../src/services/core/EquipmentTagPoolService.js';
import { loginForTest } from './helpers/auth.js';

const app = createApp();

type Auth = { Authorization: string };
interface Empresa {
  id: string;
  auth: Auth;
  userId: string;
  unidade: string;
}

let pj: Empresa;
let precoJusto: Empresa;
let oficina: Empresa;
let gringa: Empresa;
let mobilidade: string;
let maquina: { id: string; public_id: number; public_token: string };
let tagDaPj: string;
let tagDaOficina: string;

const agora = () => new Date().toISOString();

/** Gestor da empresa: o perfil passa em toda rota — o que recusa é a EMPRESA. */
async function entrar(slug: string): Promise<Omit<Empresa, 'unidade'>> {
  const res = await loginForTest(app, { userId: `gestor-${slug}`, companyId: slug, profileCodes: ['gestor'] });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return { id: String(res.body.company.id), auth: { Authorization: `Bearer ${res.body.accessToken}` }, userId: String(res.body.user.id) };
}

/** Uma moto controlada por unidade, em estoque na empresa. */
function unidadeEmEstoque(companyId: string, chave: string): string {
  const produto = String(createProduct(companyId, { name: `Moto ${chave}`, priceCents: 1_000_000 }).id);
  updateProduct(companyId, produto, { serialized: true });
  const [id] = createUnits(companyId, produto, 1, { entryReferenceType: 'ajuste', entryReferenceId: chave });
  applyMovement({
    companyId,
    productId: produto,
    movementType: 'in',
    quantity: 1,
    referenceType: 'ajuste',
    referenceId: chave,
    unitIds: [id],
  });
  return id;
}

function plaquinhaNoPool(companyId: string, publicId: number, status: string): string {
  const id = randomUUID();
  getConnection()
    .prepare(
      `INSERT INTO core_equipment_tags (id, company_id, public_id, public_token, status, printed_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(id, companyId, publicId, `tok-${id}`, status, agora(), agora(), agora());
  return id;
}

function contarTags(companyId: string): number {
  return (
    getConnection().prepare('SELECT COUNT(*) AS n FROM core_equipment_tags WHERE company_id = ?').get(companyId) as {
      n: number;
    }
  ).n;
}

beforeEach(async () => {
  resetDbForTests();
  // `loginForTest` cria cada empresa com o id igual ao slug oficial.
  pj = { ...(await entrar('pj-motors')), unidade: '' };
  precoJusto = { ...(await entrar('preco-justo')), unidade: '' };
  oficina = { ...(await entrar('oficina')), unidade: '' };
  gringa = { ...(await entrar('gringa')), unidade: '' };
  // A Oficina tem a bancada de mobilidade; a Preço Justo, a de celulares.
  ensureOfficialWorkshops();
  ensureOfficialTagCompanies();
  /*
    O PIOR BANCO ANTIGO: a marca ligada nas QUATRO empresas. É o que prova que
    quem recusa é a regra (slug da PJ), e não um zero que alguém esqueceu de
    gravar. Na PJ a marca vale; nas outras três, não vale nada.
  */
  getConnection().prepare('UPDATE core_companies SET uses_equipment_tags = 1').run();
  mobilidade = (
    getConnection().prepare("SELECT id FROM core_workshops WHERE slug = 'oficina-mobilidade'").get() as { id: string }
  ).id;

  // A moto do pátio da PJ, montada pela Oficina e adotada pela PJ.
  const criada = createEquipment({
    companyId: oficina.id,
    workshopId: mobilidade,
    userId: oficina.userId,
    origin: 'INTERNAL_PJ_MOTORS',
    brand: 'Shineray',
    model: 'Segredo 50',
  });
  maquina = { id: criada.id, public_id: criada.public_id, public_token: criada.public_token };
  pj.unidade = unidadeEmEstoque(pj.id, 'e-pj');
  vincularUnidade({ companyId: pj.id, unitId: pj.unidade, equipmentId: maquina.id, userId: pj.userId });
  precoJusto.unidade = unidadeEmEstoque(precoJusto.id, 'e-pjusto');
  oficina.unidade = unidadeEmEstoque(oficina.id, 'e-of');
  gringa.unidade = unidadeEmEstoque(gringa.id, 'e-gringa');

  // O legado de cada lado: a PJ com um adesivo livre, a Oficina com o dela.
  tagDaPj = plaquinhaNoPool(pj.id, 7001, 'disponivel');
  tagDaOficina = plaquinhaNoPool(oficina.id, 7002, 'disponivel');
});

/** Todas as rotas de plaquinha, com o que cada uma recebe. */
function rotas(quem: Empresa): { nome: string; chamar: () => request.Test }[] {
  const a = quem.auth;
  return [
    { nome: 'GET /equipment-tags', chamar: () => request(app).get('/api/v1/core/equipment-tags').set(a) },
    { nome: 'GET /equipment-tags/batches', chamar: () => request(app).get('/api/v1/core/equipment-tags/batches').set(a) },
    { nome: 'GET /equipment-tags/layout', chamar: () => request(app).get('/api/v1/core/equipment-tags/layout').set(a) },
    {
      nome: 'PUT /equipment-tags/layout',
      chamar: () => request(app).put('/api/v1/core/equipment-tags/layout').set(a).send({ bgColor: '#101820' }),
    },
    {
      nome: 'POST /equipment-tags/batches',
      chamar: () => request(app).post('/api/v1/core/equipment-tags/batches').set(a).send({ quantidade: 2 }),
    },
    {
      nome: 'POST /equipment-tags/sheet (prévia)',
      chamar: () => request(app).post('/api/v1/core/equipment-tags/sheet').set(a).send({ preview: true }),
    },
    {
      nome: 'POST /equipment-tags/sheet',
      chamar: () => request(app).post('/api/v1/core/equipment-tags/sheet').set(a).send({ tagIds: [tagDaPj, tagDaOficina] }),
    },
    {
      nome: 'POST /equipment-tags/release',
      chamar: () => request(app).post('/api/v1/core/equipment-tags/release').set(a).send({ tagIds: [tagDaOficina] }),
    },
    {
      nome: 'POST /equipment-tags/:id/damage',
      chamar: () => request(app).post(`/api/v1/core/equipment-tags/${tagDaOficina}/damage`).set(a).send({ motivo: 'x' }),
    },
    {
      nome: 'POST /equipment-tags/:id/replace',
      chamar: () =>
        request(app)
          .post(`/api/v1/core/equipment-tags/${tagDaOficina}/replace`)
          .set(a)
          .send({ equipmentId: maquina.id, motivo: 'x' }),
    },
    {
      nome: 'POST /labels/equipment',
      chamar: () => request(app).post('/api/v1/core/labels/equipment').set(a).send({ equipmentIds: [maquina.id] }),
    },
    {
      nome: 'POST /labels/equipment/sheet',
      chamar: () => request(app).post('/api/v1/core/labels/equipment/sheet').set(a).send({ equipmentIds: [maquina.id] }),
    },
    { nome: 'GET /labels/equipment/formats', chamar: () => request(app).get('/api/v1/core/labels/equipment/formats').set(a) },
    {
      nome: 'GET /units/equipment-candidates',
      chamar: () => request(app).get('/api/v1/core/units/equipment-candidates').set(a),
    },
    {
      nome: 'POST /units/:id/equipment',
      chamar: () => request(app).post(`/api/v1/core/units/${quem.unidade}/equipment`).set(a).send({ equipmentId: maquina.id }),
    },
    {
      nome: 'POST /units/:id/equipment/sheet',
      chamar: () => request(app).post(`/api/v1/core/units/${quem.unidade}/equipment/sheet`).set(a).send({}),
    },
    { nome: 'DELETE /units/:id/equipment', chamar: () => request(app).delete(`/api/v1/core/units/${quem.unidade}/equipment`).set(a) },
    {
      nome: 'POST /print/jobs EQUIPMENT_QR_TAG',
      chamar: () =>
        request(app).post('/api/v1/core/print/jobs').set(a).send({ documentType: 'EQUIPMENT_QR_TAG', documentId: maquina.id }),
    },
  ];
}

describe('toda rota de plaquinha recusa quem não é a PJ Motors', () => {
  for (const [nome, qual] of [
    ['Preço Justo', () => precoJusto],
    ['Oficina', () => oficina],
    ['Gringa (outra loja)', () => gringa],
  ] as const) {
    it(`${nome}: 403 CORE_COMPANY_NO_TAGS em todas, sem número, token nem máquina de ninguém`, async () => {
      const quem = qual();
      const tagsAntes = { pj: contarTags(pj.id), oficina: contarTags(oficina.id), dela: contarTags(quem.id) };
      for (const rota of rotas(quem)) {
        const res = await rota.chamar();
        expect(res.status, `${rota.nome}: ${JSON.stringify(res.body)}`).toBe(403);
        expect(res.body.error?.code, rota.nome).toBe('CORE_COMPANY_NO_TAGS');
        const corpo = JSON.stringify(res.body);
        for (const segredo of ['#7001', '#7002', maquina.public_token, 'Segredo 50', `tok-${tagDaPj}`, `tok-${tagDaOficina}`]) {
          expect(corpo, `${rota.nome} vazou ${segredo}`).not.toContain(segredo);
        }
      }
      // Nada foi escrito pela tentativa: nem lote, nem liberação, nem dano.
      expect(contarTags(pj.id)).toBe(tagsAntes.pj);
      expect(contarTags(oficina.id)).toBe(tagsAntes.oficina);
      expect(contarTags(quem.id)).toBe(tagsAntes.dela);
      const daOficina = getConnection().prepare('SELECT status FROM core_equipment_tags WHERE id = ?').get(tagDaOficina) as {
        status: string;
      };
      expect(daOficina.status).toBe('disponivel');
      // E o vínculo da PJ continua de pé: ninguém de fora o soltou.
      const vinculo = getConnection().prepare('SELECT equipment_id FROM core_product_units WHERE id = ?').get(pj.unidade) as {
        equipment_id: string | null;
      };
      expect(vinculo.equipment_id).toBe(maquina.id);
    });
  }

  it('o cadastro da máquina não aceita adesivo do pool fora da PJ — a Oficina e a Preço Justo levam 403', async () => {
    for (const quem of [oficina, precoJusto]) {
      const bancada = quem === oficina ? mobilidade : (
        getConnection().prepare("SELECT id FROM core_workshops WHERE slug = 'oficina-celulares'").get() as { id: string }
      ).id;
      const res = await request(app)
        .post(`/api/v1/core/equipment?workshopId=${bancada}`)
        .set(quem.auth)
        .send({ origin: 'INTERNAL_PJ_MOTORS', brand: 'Shineray', model: 'Com adesivo', tagPublicId: 7002 });
      expect(res.status, JSON.stringify(res.body)).toBe(403);
      expect(res.body.error.code).toBe('CORE_COMPANY_NO_TAGS');
    }
    // Sem adesivo, o cadastro da Oficina segue como sempre: o número é sorteado.
    const semAdesivo = await request(app)
      .post(`/api/v1/core/equipment?workshopId=${mobilidade}`)
      .set(oficina.auth)
      .send({ origin: 'INTERNAL_PJ_MOTORS', brand: 'Shineray', model: 'Sem adesivo' });
    expect(semAdesivo.status, JSON.stringify(semAdesivo.body)).toBe(201);
  });

  it('a Oficina segue lendo a própria máquina e abrindo OS — só leitura do número, sem gesto de plaquinha', async () => {
    const ficha = await request(app).get(`/api/v1/core/equipment/${maquina.id}`).set(oficina.auth);
    expect(ficha.status, JSON.stringify(ficha.body)).toBe(200);
    expect(ficha.body.publicIdLabel).toBe(`#${String(maquina.public_id).padStart(4, '0')}`);
    expect(ficha.body.plaquinha).toEqual({ empresaUsa: false, bancadaUsa: true });
    const os = await request(app)
      .post('/api/v1/core/workshop/orders')
      .set(oficina.auth)
      .send({ equipmentId: maquina.id, complaint: 'revisão de montagem', workshopId: mobilidade });
    expect(os.status, JSON.stringify(os.body)).toBe(201);
  });
});

describe('a PJ Motors usa as mesmas rotas', () => {
  it('lê o pool, os lotes, o layout e os formatos — e só o que é dela', async () => {
    const pool = await request(app).get('/api/v1/core/equipment-tags').set(pj.auth);
    expect(pool.status, JSON.stringify(pool.body)).toBe(200);
    const ids = (pool.body.items as { id: string; company_id: string }[]).map((t) => t.id);
    expect(ids).toContain(tagDaPj);
    expect(ids).not.toContain(tagDaOficina);
    expect((pool.body.items as { company_id: string }[]).every((t) => t.company_id === pj.id)).toBe(true);
    expect(JSON.stringify(pool.body)).not.toContain('#7002');
    expect(pool.body.usaPlaquinha).toBe(true);

    for (const url of ['/api/v1/core/equipment-tags/batches', '/api/v1/core/equipment-tags/layout', '/api/v1/core/labels/equipment/formats']) {
      const res = await request(app).get(url).set(pj.auth);
      expect(res.status, `${url}: ${JSON.stringify(res.body)}`).toBe(200);
    }
    const layout = await request(app).put('/api/v1/core/equipment-tags/layout').set(pj.auth).send({ bgColor: '#101820' });
    expect(layout.status, JSON.stringify(layout.body)).toBe(200);
    const previa = await request(app).post('/api/v1/core/equipment-tags/sheet').set(pj.auth).send({ preview: true });
    expect(previa.status).toBe(200);
  });

  /*
    Este caso cobrava o contrário: a PJ passava pela regra da empresa e parava
    na da BANCADA (409 `CORE_TAGS_NEED_WORKSHOP`), porque não monta moto — e
    assim ninguém no grupo gerava lote novo. O dono decidiu que a PJ gera,
    imprime e libera as plaquinhas dela sem bancada: a regra da empresa é o
    portão inteiro.
  */
  it('gerar, imprimir e liberar passam só pela regra da empresa — a PJ não tem bancada, e não precisa', async () => {
    const lote = await request(app).post('/api/v1/core/equipment-tags/batches').set(pj.auth).send({ quantidade: 2 });
    expect(lote.status, JSON.stringify(lote.body)).toBe(201);
    const folha = await request(app)
      .post('/api/v1/core/equipment-tags/sheet')
      .set(pj.auth)
      .send({ batchId: lote.body.batchId });
    expect(folha.status, JSON.stringify(folha.body)).toBe(200);
    expect(folha.body.plaquinhas).toBe(2);
    const libera = await request(app)
      .post('/api/v1/core/equipment-tags/release')
      .set(pj.auth)
      .send({ batchId: lote.body.batchId });
    expect(libera.status, JSON.stringify(libera.body)).toBe(200);
    expect(libera.body).toEqual({ liberadas: 2 });
  });

  it('marca o próprio adesivo como danificado; o da Oficina não existe para ela', async () => {
    const minha = await request(app).post(`/api/v1/core/equipment-tags/${tagDaPj}/damage`).set(pj.auth).send({ motivo: 'borrou' });
    expect(minha.status, JSON.stringify(minha.body)).toBe(200);
    expect(minha.body.public_token).toBeUndefined();
    const alheia = await request(app).post(`/api/v1/core/equipment-tags/${tagDaOficina}/damage`).set(pj.auth).send({ motivo: 'x' });
    expect(alheia.status).toBe(404);
    expect(alheia.body.error.code).toBe('CORE_TAG_NOT_FOUND');
  });

  it('reimprime pela unidade, desvincula, vê a moto nas candidatas e vincula de novo', async () => {
    const folha = await request(app).post(`/api/v1/core/units/${pj.unidade}/equipment/sheet`).set(pj.auth).send({});
    expect(folha.status, JSON.stringify(folha.body)).toBe(200);
    expect(folha.body.publicIdLabel).toBe(`#${String(maquina.public_id).padStart(4, '0')}`);

    const solta = await request(app).delete(`/api/v1/core/units/${pj.unidade}/equipment`).set(pj.auth);
    expect(solta.status, JSON.stringify(solta.body)).toBe(204);

    const candidatas = await request(app).get('/api/v1/core/units/equipment-candidates').set(pj.auth);
    expect(candidatas.status).toBe(200);
    expect((candidatas.body.items as { id: string }[]).map((c) => c.id)).toContain(maquina.id);

    const liga = await request(app).post(`/api/v1/core/units/${pj.unidade}/equipment`).set(pj.auth).send({ equipmentId: maquina.id });
    expect(liga.status, JSON.stringify(liga.body)).toBe(201);
  });

  it('a lista de unidades da PJ traz o bloco da plaquinha; a de outra loja com vínculo antigo, não', async () => {
    const produtoPj = (
      getConnection().prepare('SELECT product_id FROM core_product_units WHERE id = ?').get(pj.unidade) as { product_id: string }
    ).product_id;
    const daPj = await request(app).get(`/api/v1/core/units/${produtoPj}`).set(pj.auth);
    expect(daPj.status).toBe(200);
    expect(daPj.body.items[0].plaquinha?.id).toBe(maquina.id);

    // Um vínculo que a Gringa fez antes da regra, gravado como o banco o guarda.
    const outra = createEquipment({
      companyId: oficina.id,
      workshopId: mobilidade,
      userId: oficina.userId,
      origin: 'INTERNAL_PJ_MOTORS',
      brand: 'Honda',
      model: 'Antiga',
    });
    getConnection().prepare('UPDATE core_product_units SET equipment_id = ? WHERE id = ?').run(outra.id, gringa.unidade);
    const produtoGringa = (
      getConnection().prepare('SELECT product_id FROM core_product_units WHERE id = ?').get(gringa.unidade) as { product_id: string }
    ).product_id;
    const daGringa = await request(app).get(`/api/v1/core/units/${produtoGringa}`).set(gringa.auth);
    expect(daGringa.status).toBe(200);
    expect(daGringa.body.items[0].plaquinha).toBeNull();
    expect(JSON.stringify(daGringa.body)).not.toContain('Oficina de Mobilidade');
  });
});

describe('a marca no banco: só a PJ, idempotente, sem apagar nada', () => {
  it('ensureOfficialTagCompanies marca só a PJ, não sobrescreve a marca velha e não toca no pool', () => {
    resetDbForTests();
    const ids = Object.fromEntries(
      ['pj-motors', 'preco-justo', 'oficina', 'gringa', 'me-mimei', 'conceito'].map((slug) => [
        slug,
        upsertCompany({ slug, legalName: `${slug} Ltda`, tradeName: slug }),
      ]),
    ) as Record<string, string>;
    // O banco antigo: a Oficina marcada e com plaquinha no pool.
    getConnection().prepare('UPDATE core_companies SET uses_equipment_tags = 1 WHERE id = ?').run(ids.oficina);
    plaquinhaNoPool(ids.oficina, 8001, 'disponivel');
    plaquinhaNoPool(ids.oficina, 8002, 'gerada');

    ensureOfficialTagCompanies();
    ensureOfficialTagCompanies();

    const marca = (id: string) =>
      (getConnection().prepare('SELECT uses_equipment_tags AS f FROM core_companies WHERE id = ?').get(id) as { f: number }).f;
    expect(marca(ids['pj-motors'])).toBe(1);
    for (const slug of ['preco-justo', 'gringa', 'me-mimei', 'conceito']) expect(marca(ids[slug])).toBe(0);
    // A marca velha da Oficina fica como estava (nada é sobrescrito)...
    expect(marca(ids.oficina)).toBe(1);
    // ...e não vale nada: a regra exige o slug da PJ.
    expect(empresaUsaPlaquinha(ids.oficina)).toBe(false);
    expect(empresaUsaPlaquinha(ids['pj-motors'])).toBe(true);
    // As plaquinhas da Oficina continuam no banco, intactas.
    expect(contarTags(ids.oficina)).toBe(2);
  });
});
