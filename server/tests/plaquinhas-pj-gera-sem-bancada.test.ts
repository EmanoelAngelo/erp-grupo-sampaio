/**
 * ============================================================================
 * A PJ MOTORS GERA PLAQUINHA SEM BANCADA — e só ela
 * ============================================================================
 *
 * ## A contradição que isto derruba
 *
 * O P0 das plaquinhas fez a plaquinha EXCLUSIVA da PJ Motors
 * (`exigirEmpresaComPlaquinha`: 403 `CORE_COMPANY_NO_TAGS` para qualquer outra
 * empresa). Uma regra mais velha (GAP-PRD-110, "quem gera plaquinha é quem tem
 * bancada") exigia bancada ativa na empresa para gerar, imprimir a folha e
 * liberar — 409 `CORE_TAGS_NEED_WORKSHOP`. A PJ não tem bancada. Somadas, a
 * única empresa com plaquinha não gerava, e o grupo ficou sem ninguém que
 * gerasse lote novo.
 *
 * O dono decidiu: a PJ Motors acessa, gera, imprime, consulta e administra as
 * plaquinhas dela, e o portão é a EMPRESA. A regra da bancada saiu da
 * plaquinha.
 *
 * ## O que este arquivo prova, pelas rotas de verdade, num banco descartável
 *
 *   1. a PJ, SEM bancada nenhuma, com o gestor dela (`gerente_loja`, o modelo
 *      do login `ADMIN-PJ MOTORS`): gera lote, lista o pool e os lotes, lê e
 *      grava o layout, vê a prévia, imprime a folha, libera e marca
 *      danificada — e o adesivo antigo que ficou em `gerada` também vai ao
 *      papel e é liberado;
 *   2. vincula a plaquinha da moto à unidade do próprio estoque (Estoque ›
 *      Unidades), reimprime, desvincula, vincula de novo — e o QR da moto
 *      vinculada abre a página pública (não 404);
 *   3. o caixa do PDV da PJ (`operador_caixa_loja`, o modelo do login
 *      `PJ MOTORS`) não administra nada disso: 403 em cada gesto;
 *   4. Preço Justo, Oficina (COM bancada) e Gringa levam 403
 *      `CORE_COMPANY_NO_TAGS` em cada uma dessas rotas, sem ver número, token
 *      ou máquina da PJ e sem gravar nada — com a marca desligada ou ligada no
 *      banco.
 *
 * ## As mordidas
 *
 *   - volte `EquipmentTagPoolService.ts` para a regra da bancada e o caso 1
 *     fica vermelho no primeiro lote (409 `CORE_TAGS_NEED_WORKSHOP`);
 *   - volte a recusa da bancada em `POST /equipment-tags/sheet` e o caso do
 *     adesivo antigo fica vermelho na folha;
 *   - tire `exigirEmpresaComPlaquinha` de qualquer rota da lista e o caso 4
 *     fica vermelho para as três empresas.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import { createApp } from '../src/app.js';
import { getConnection } from '../src/db/sqlite.js';
import { resetDbForTests } from '../src/db/database.js';
import { ensureOfficialTagCompanies, ensureOfficialWorkshops } from '../src/db/core-migrations.js';
import { createProduct, updateProduct } from '../src/services/core/CatalogService.js';
import { applyMovement } from '../src/services/core/InventoryService.js';
import { createUnits } from '../src/services/core/ProductUnitService.js';
import { createEquipment } from '../src/services/core/EquipmentService.js';
import { loginForTest } from './helpers/auth.js';

const app = createApp();

type Auth = { Authorization: string };
interface Sessao {
  id: string;
  auth: Auth;
  userId: string;
}

/** O gestor da PJ — `gerente_loja`, o modelo do `ADMIN-PJ MOTORS`. */
let pj: Sessao;
/** O caixa do PDV da PJ — `operador_caixa_loja`, o modelo do login `PJ MOTORS`. */
let pdvPj: Sessao;
let precoJusto: Sessao;
let oficina: Sessao;
let gringa: Sessao;
let unidadePj: string;
let maquina: { id: string; public_id: number; public_token: string };

const agora = () => new Date().toISOString();
const rotulo = (n: number) => `#${String(n).padStart(4, '0')}`;

async function entrar(userId: string, slug: string, perfil: string): Promise<Sessao> {
  const res = await loginForTest(app, { userId, companyId: slug, profileCodes: [perfil] });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return {
    id: String(res.body.company.id),
    auth: { Authorization: `Bearer ${res.body.accessToken}` },
    userId: String(res.body.user.id),
  };
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

/** Um adesivo no pool, gravado como o banco o guarda. */
function plaquinhaNoPool(
  companyId: string,
  publicId: number,
  status: string,
  extra: { batchId?: string; impressa?: boolean } = {},
): string {
  const id = randomUUID();
  getConnection()
    .prepare(
      `INSERT INTO core_equipment_tags
         (id, company_id, public_id, public_token, status, batch_id, printed_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(id, companyId, publicId, `tok-${id}`, status, extra.batchId ?? null, extra.impressa ? agora() : null, agora(), agora());
  return id;
}

function bancadasAtivas(companyId: string): number {
  return (
    getConnection()
      .prepare('SELECT COUNT(*) AS n FROM core_workshops WHERE company_id = ? AND active = 1')
      .get(companyId) as { n: number }
  ).n;
}

function tagsDa(companyId: string): number {
  return (
    getConnection().prepare('SELECT COUNT(*) AS n FROM core_equipment_tags WHERE company_id = ?').get(companyId) as {
      n: number;
    }
  ).n;
}

function situacao(tagId: string): { status: string; printed_at: string | null } {
  return getConnection().prepare('SELECT status, printed_at FROM core_equipment_tags WHERE id = ?').get(tagId) as {
    status: string;
    printed_at: string | null;
  };
}

function vinculoDa(unitId: string): string | null {
  return (
    getConnection().prepare('SELECT equipment_id FROM core_product_units WHERE id = ?').get(unitId) as {
      equipment_id: string | null;
    }
  ).equipment_id;
}

beforeEach(async () => {
  resetDbForTests();
  // `loginForTest` cria cada empresa com o id igual ao slug oficial.
  pj = await entrar('admin-pj', 'pj-motors', 'gerente_loja');
  pdvPj = await entrar('pdv-pj', 'pj-motors', 'operador_caixa_loja');
  precoJusto = await entrar('admin-pjusto', 'preco-justo', 'gerente_loja');
  oficina = await entrar('admin-oficina', 'oficina', 'gerente_oficina');
  gringa = await entrar('admin-gringa', 'gringa', 'gerente_loja');
  // As bancadas oficiais: a de mobilidade na Oficina, a de celulares na Preço
  // Justo. A PJ Motors não ganha nenhuma — é o cenário inteiro deste arquivo.
  ensureOfficialWorkshops();
  ensureOfficialTagCompanies();

  /*
    A MOTO DO PÁTIO DA PJ. A máquina (com número e QR) é cadastrada pela
    bancada que a monta — hoje a da Oficina, com o número sorteado da
    sequência do grupo, porque a Oficina não escolhe adesivo de pool nenhum.
    Quem vende a moto e administra a plaquinha dela é a PJ, pela unidade.
  */
  const mobilidade = (
    getConnection().prepare("SELECT id FROM core_workshops WHERE slug = 'oficina-mobilidade'").get() as { id: string }
  ).id;
  const criada = createEquipment({
    companyId: oficina.id,
    workshopId: mobilidade,
    userId: oficina.userId,
    origin: 'INTERNAL_PJ_MOTORS',
    brand: 'Shineray',
    model: 'Jet 50',
  });
  maquina = { id: criada.id, public_id: criada.public_id, public_token: criada.public_token };
  unidadePj = unidadeEmEstoque(pj.id, 'e-pj');
});

/** Os gestos de ADMINISTRAR plaquinha, com o que cada um recebe. */
function gestosDePlaquinha(
  a: Auth,
  alvo: { lote: string; tag: string; unidade: string },
): { nome: string; chamar: () => request.Test }[] {
  return [
    { nome: 'GET /equipment-tags', chamar: () => request(app).get('/api/v1/core/equipment-tags').set(a) },
    { nome: 'GET /equipment-tags/batches', chamar: () => request(app).get('/api/v1/core/equipment-tags/batches').set(a) },
    {
      nome: 'POST /equipment-tags/batches',
      chamar: () => request(app).post('/api/v1/core/equipment-tags/batches').set(a).send({ quantidade: 2 }),
    },
    { nome: 'GET /equipment-tags/layout', chamar: () => request(app).get('/api/v1/core/equipment-tags/layout').set(a) },
    {
      nome: 'PUT /equipment-tags/layout',
      chamar: () => request(app).put('/api/v1/core/equipment-tags/layout').set(a).send({ bgColor: '#101820' }),
    },
    { nome: 'GET /labels/equipment/formats', chamar: () => request(app).get('/api/v1/core/labels/equipment/formats').set(a) },
    {
      nome: 'POST /equipment-tags/sheet (prévia)',
      chamar: () => request(app).post('/api/v1/core/equipment-tags/sheet').set(a).send({ preview: true }),
    },
    {
      nome: 'POST /equipment-tags/sheet (lote)',
      chamar: () => request(app).post('/api/v1/core/equipment-tags/sheet').set(a).send({ batchId: alvo.lote }),
    },
    {
      nome: 'POST /equipment-tags/release',
      chamar: () => request(app).post('/api/v1/core/equipment-tags/release').set(a).send({ batchId: alvo.lote }),
    },
    {
      nome: 'POST /equipment-tags/:id/damage',
      chamar: () => request(app).post(`/api/v1/core/equipment-tags/${alvo.tag}/damage`).set(a).send({ motivo: 'x' }),
    },
    {
      nome: 'POST /labels/equipment/sheet',
      chamar: () => request(app).post('/api/v1/core/labels/equipment/sheet').set(a).send({ equipmentIds: [maquina.id] }),
    },
    {
      nome: 'GET /units/equipment-candidates',
      chamar: () => request(app).get('/api/v1/core/units/equipment-candidates').set(a),
    },
    {
      nome: 'POST /units/:id/equipment',
      chamar: () =>
        request(app).post(`/api/v1/core/units/${alvo.unidade}/equipment`).set(a).send({ equipmentId: maquina.id }),
    },
    {
      nome: 'POST /units/:id/equipment/sheet',
      chamar: () => request(app).post(`/api/v1/core/units/${alvo.unidade}/equipment/sheet`).set(a).send({}),
    },
    {
      nome: 'DELETE /units/:id/equipment',
      chamar: () => request(app).delete(`/api/v1/core/units/${alvo.unidade}/equipment`).set(a),
    },
    // O adesivo do lote da PJ na moto do estoque (P0 das plaquinhas): colar,
    // soltar e trocar. Os dois laços que usam esta lista são de RECUSA — o
    // caixa do PDV e as outras empresas —, então as três entram cobertas.
    {
      nome: 'POST /units/:id/tag',
      chamar: () => request(app).post(`/api/v1/core/units/${alvo.unidade}/tag`).set(a).send({ tagId: alvo.tag }),
    },
    {
      nome: 'DELETE /units/:id/tag',
      chamar: () => request(app).delete(`/api/v1/core/units/${alvo.unidade}/tag`).set(a),
    },
    {
      nome: 'POST /units/:id/tag/replace',
      chamar: () =>
        request(app)
          .post(`/api/v1/core/units/${alvo.unidade}/tag/replace`)
          .set(a)
          .send({ novaTagId: alvo.tag, motivo: 'x' }),
    },
  ];
}

describe('a PJ Motors, sem bancada, administra as plaquinhas dela', () => {
  it('gera o lote, consulta pool e lotes, mexe no layout, imprime, libera e marca danificada', async () => {
    expect(bancadasAtivas(pj.id)).toBe(0);
    const a = pj.auth;

    const lote = await request(app).post('/api/v1/core/equipment-tags/batches').set(a).send({ quantidade: 3 });
    expect(lote.status, JSON.stringify(lote.body)).toBe(201);
    expect(lote.body.criadas).toBe(3);
    expect(lote.body.ultima - lote.body.primeira).toBe(2);
    const batchId = String(lote.body.batchId);

    const pool = await request(app).get(`/api/v1/core/equipment-tags?batchId=${batchId}`).set(a);
    expect(pool.status, JSON.stringify(pool.body)).toBe(200);
    expect(pool.body.usaPlaquinha).toBe(true);
    const itens = pool.body.items as { id: string; company_id: string; status: string; public_token?: string }[];
    expect(itens).toHaveLength(3);
    expect(itens.every((t) => t.company_id === pj.id && t.status === 'gerada')).toBe(true);
    // A credencial do QR não viaja na lista.
    expect(itens.every((t) => t.public_token === undefined)).toBe(true);

    const lotes = await request(app).get('/api/v1/core/equipment-tags/batches').set(a);
    expect(lotes.status, JSON.stringify(lotes.body)).toBe(200);
    expect(lotes.body.items).toEqual([expect.objectContaining({ batchId, total: 3, geradas: 3, impressas: 0 })]);

    // A cara do adesivo é da PJ: lê, grava e relê.
    const layout = await request(app).get('/api/v1/core/equipment-tags/layout').set(a);
    expect(layout.status, JSON.stringify(layout.body)).toBe(200);
    const grava = await request(app).put('/api/v1/core/equipment-tags/layout').set(a).send({ bgColor: '#101820' });
    expect(grava.status, JSON.stringify(grava.body)).toBe(200);
    const relido = await request(app).get('/api/v1/core/equipment-tags/layout').set(a);
    expect(relido.body.layout.bgColor).toBe('#101820');

    const formatos = await request(app).get('/api/v1/core/labels/equipment/formats').set(a);
    expect(formatos.status, JSON.stringify(formatos.body)).toBe(200);
    expect((formatos.body.items as unknown[]).length).toBeGreaterThan(0);

    const previa = await request(app).post('/api/v1/core/equipment-tags/sheet').set(a).send({ preview: true });
    expect(previa.status, JSON.stringify(previa.body)).toBe(200);
    expect(previa.body.preview).toBe(true);

    const folha = await request(app).post('/api/v1/core/equipment-tags/sheet').set(a).send({ batchId });
    expect(folha.status, JSON.stringify(folha.body)).toBe(200);
    expect(folha.body.plaquinhas).toBe(3);
    expect(itens.every((t) => Boolean(situacao(t.id).printed_at))).toBe(true);

    const libera = await request(app).post('/api/v1/core/equipment-tags/release').set(a).send({ batchId });
    expect(libera.status, JSON.stringify(libera.body)).toBe(200);
    expect(libera.body).toEqual({ liberadas: 3 });

    const livres = await request(app).get('/api/v1/core/equipment-tags?status=disponivel').set(a);
    expect(livres.status).toBe(200);
    expect(livres.body.items).toHaveLength(3);
    expect(livres.body.resumo).toMatchObject({ disponivel: 3, total: 3 });

    const dano = await request(app)
      .post(`/api/v1/core/equipment-tags/${itens[0]!.id}/damage`)
      .set(a)
      .send({ motivo: 'impressão borrada' });
    expect(dano.status, JSON.stringify(dano.body)).toBe(200);
    expect(dano.body).toMatchObject({ status: 'danificada', damaged_reason: 'impressão borrada' });
    expect(dano.body.public_token).toBeUndefined();

    // Cada gesto ficou na trilha da PJ.
    const trilha = (
      getConnection()
        .prepare("SELECT action FROM core_audit_log WHERE company_id = ? AND action LIKE 'equipment.tags.%'")
        .all(pj.id) as { action: string }[]
    ).map((l) => l.action);
    expect(trilha).toEqual(
      expect.arrayContaining(['equipment.tags.batch', 'equipment.tags.layout', 'equipment.tags.release', 'equipment.tags.damage']),
    );
  });

  it('o adesivo que ficou em "gerada" antes da decisão vai ao papel pela seleção e é liberado', async () => {
    const antigo = plaquinhaNoPool(pj.id, 9001, 'gerada');

    const folha = await request(app).post('/api/v1/core/equipment-tags/sheet').set(pj.auth).send({ tagIds: [antigo] });
    expect(folha.status, JSON.stringify(folha.body)).toBe(200);
    expect(folha.body).toMatchObject({ plaquinhas: 1, naoAchados: [] });
    expect(situacao(antigo).printed_at).toBeTruthy();

    const libera = await request(app).post('/api/v1/core/equipment-tags/release').set(pj.auth).send({ tagIds: [antigo] });
    expect(libera.status, JSON.stringify(libera.body)).toBe(200);
    expect(situacao(antigo).status).toBe('disponivel');
  });

  it('vincula a plaquinha da moto à unidade do próprio estoque, reimprime, desvincula — e o QR responde', async () => {
    const a = pj.auth;

    const candidatas = await request(app).get('/api/v1/core/units/equipment-candidates').set(a);
    expect(candidatas.status, JSON.stringify(candidatas.body)).toBe(200);
    expect((candidatas.body.items as { id: string }[]).map((c) => c.id)).toContain(maquina.id);

    const liga = await request(app).post(`/api/v1/core/units/${unidadePj}/equipment`).set(a).send({ equipmentId: maquina.id });
    expect(liga.status, JSON.stringify(liga.body)).toBe(201);
    expect(liga.body.plaquinha).toMatchObject({ id: maquina.id, publicIdLabel: rotulo(maquina.public_id) });
    expect(vinculoDa(unidadePj)).toBe(maquina.id);

    const folha = await request(app).post(`/api/v1/core/units/${unidadePj}/equipment/sheet`).set(a).send({});
    expect(folha.status, JSON.stringify(folha.body)).toBe(200);
    expect(folha.body).toMatchObject({ publicIdLabel: rotulo(maquina.public_id), plaquinhas: 1 });

    // O QR colado na moto abre a página pública, sem sessão nenhuma.
    const qr = await request(app).get(`/api/v1/loja/equipamento/${maquina.public_token}`);
    expect(qr.status, JSON.stringify(qr.body)).toBe(200);
    expect(qr.body).toMatchObject({ publicIdLabel: rotulo(maquina.public_id), brand: 'Shineray', model: 'Jet 50' });

    const solta = await request(app).delete(`/api/v1/core/units/${unidadePj}/equipment`).set(a);
    expect(solta.status, JSON.stringify(solta.body)).toBe(204);
    expect(vinculoDa(unidadePj)).toBeNull();

    // Soltar não queima nada: a moto volta às candidatas e é vinculada de novo.
    const deNovo = await request(app).post(`/api/v1/core/units/${unidadePj}/equipment`).set(a).send({ equipmentId: maquina.id });
    expect(deNovo.status, JSON.stringify(deNovo.body)).toBe(201);
    const qrDepois = await request(app).get(`/api/v1/loja/equipamento/${maquina.public_token}`);
    expect(qrDepois.status).toBe(200);
  });

  it('o caixa do PDV da PJ não administra plaquinha: 403 em cada gesto, e nada muda (PDV não administra)', async () => {
    const lote = 'lote-da-pj';
    plaquinhaNoPool(pj.id, 7201, 'gerada', { batchId: lote, impressa: true });
    const livre = plaquinhaNoPool(pj.id, 7202, 'disponivel', { batchId: lote, impressa: true });
    const antes = tagsDa(pj.id);

    for (const gesto of gestosDePlaquinha(pdvPj.auth, { lote, tag: livre, unidade: unidadePj })) {
      const res = await gesto.chamar();
      expect(res.status, `${gesto.nome}: ${JSON.stringify(res.body)}`).toBe(403);
      expect(res.body.error?.code, gesto.nome).toBe('API_PERMISSION_DENIED');
    }
    expect(tagsDa(pj.id)).toBe(antes);
    expect(situacao(livre).status).toBe('disponivel');
    expect(vinculoDa(unidadePj)).toBeNull();
  });
});

describe('fora da PJ Motors, toda rota de plaquinha é 403 — com bancada ou sem, com a marca ou sem', () => {
  for (const [nome, qual] of [
    ['Preço Justo', () => precoJusto],
    ['Oficina (com bancada)', () => oficina],
    ['Gringa', () => gringa],
  ] as const) {
    for (const marcaLigada of [false, true]) {
      it(`${nome}${marcaLigada ? ', com a marca ligada no banco' : ''}: 403 CORE_COMPANY_NO_TAGS, sem dado da PJ e sem gravar nada`, async () => {
        const quem = qual();
        /*
          O PIOR BANCO ANTIGO: a marca ligada em todas as empresas. Quem recusa
          é a regra da empresa (slug da PJ), não um zero esquecido na coluna.
        */
        if (marcaLigada) getConnection().prepare('UPDATE core_companies SET uses_equipment_tags = 1').run();
        if (quem === oficina) {
          // A bancada não dá plaquinha a ninguém: a Oficina tem, e leva 403.
          expect(bancadasAtivas(oficina.id)).toBeGreaterThan(0);
        }

        const lote = 'lote-da-pj';
        const geradaPj = plaquinhaNoPool(pj.id, 7101, 'gerada', { batchId: lote, impressa: true });
        const livrePj = plaquinhaNoPool(pj.id, 7102, 'disponivel', { batchId: lote, impressa: true });
        const unidadeDela = unidadeEmEstoque(quem.id, `e-${quem.id}`);
        const antes = { pj: tagsDa(pj.id), dela: tagsDa(quem.id) };

        const gestos = [
          ...gestosDePlaquinha(quem.auth, { lote, tag: livrePj, unidade: unidadeDela }),
          {
            nome: 'POST /print/jobs EQUIPMENT_QR_TAG',
            chamar: () =>
              request(app)
                .post('/api/v1/core/print/jobs')
                .set(quem.auth)
                .send({ documentType: 'EQUIPMENT_QR_TAG', documentId: maquina.id }),
          },
        ];
        for (const gesto of gestos) {
          const res = await gesto.chamar();
          expect(res.status, `${gesto.nome}: ${JSON.stringify(res.body)}`).toBe(403);
          expect(res.body.error?.code, gesto.nome).toBe('CORE_COMPANY_NO_TAGS');
          const corpo = JSON.stringify(res.body);
          for (const segredo of ['#7101', '#7102', `tok-${geradaPj}`, `tok-${livrePj}`, maquina.public_token, 'Jet 50']) {
            expect(corpo, `${gesto.nome} vazou ${segredo}`).not.toContain(segredo);
          }
        }

        // Nada foi escrito pela tentativa: nem lote, nem papel, nem liberação, nem vínculo.
        expect(tagsDa(pj.id)).toBe(antes.pj);
        expect(tagsDa(quem.id)).toBe(antes.dela);
        expect(situacao(geradaPj).status).toBe('gerada');
        expect(situacao(livrePj).status).toBe('disponivel');
        expect(vinculoDa(unidadeDela)).toBeNull();
      });
    }
  }
});
