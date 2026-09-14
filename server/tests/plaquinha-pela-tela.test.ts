/**
 * ============================================================================
 * A PLAQUINHA SEM DESENVOLVEDOR — quem usa, quem troca e quem reimprime
 * (GAP-PRD-185, GAP-PRD-107, GAP-PRD-190)
 * ============================================================================
 *
 * ## O que a auditoria mediu
 *
 *   - GAP-PRD-185: `uses_equipment_tags` só era gravado pelo passo de migração
 *     (slugs `oficina` e `pj-motors`). A sétima oficina nascia pela tela e o
 *     pool recusava a primeira folha com CORE_COMPANY_NO_TAGS — UPDATE à mão.
 *   - GAP-PRD-107: trocar o adesivo existia só na API; a ficha da máquina não
 *     sabia se podia oferecer o gesto. (O servidor da troca já é coberto por
 *     `plaquinhas-pool`; aqui a ficha ganha o que precisa para a tela.)
 *   - GAP-PRD-190: a PJ Motors vende a moto e não reimprimia a plaquinha: as
 *     rotas de etiqueta procuram o equipamento pela empresa da sessão, e ele
 *     vive na Oficina.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import { createApp } from '../src/app.js';
import { resetDbForTests } from '../src/db/database.js';
import { ensureCoreSchema } from '../src/db/schema.js';
import { getConnection } from '../src/db/sqlite.js';
import {
  linkUserToCompany,
  upsertCompany,
  upsertUser,
} from '../src/services/auth/IdentityService.js';
import { createProduct, updateProduct } from '../src/services/core/CatalogService.js';
import { applyMovement } from '../src/services/core/InventoryService.js';
import { createUnits } from '../src/services/core/ProductUnitService.js';
import { createEquipment } from '../src/services/core/EquipmentService.js';
import { vincularUnidade } from '../src/services/core/EquipmentStockLink.js';

const app = createApp();
const SENHA = 'Plaquinha@2026';

async function entrar(login: string, companyId?: string): Promise<{ Authorization: string }> {
  const res = await request(app).post('/api/v1/auth/login').send({ login, password: SENHA, companyId });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return { Authorization: `Bearer ${res.body.accessToken}` };
}

function flag(companyId: string): number {
  return (
    getConnection().prepare('SELECT uses_equipment_tags AS f FROM core_companies WHERE id = ?').get(companyId) as {
      f: number;
    }
  ).f;
}

function bancada(companyId: string, slug: string, kind: 'mobility' | 'phones' = 'mobility'): string {
  const id = randomUUID();
  getConnection()
    .prepare(
      `INSERT INTO core_workshops (id, company_id, slug, name, kind, active, created_at)
       VALUES (?, ?, ?, ?, ?, 1, ?)`,
    )
    .run(id, companyId, slug, `Bancada ${slug}`, kind, new Date().toISOString());
  return id;
}

// ---------------------------------------------------------------- GAP-PRD-185

describe('GAP-PRD-185 — a operação nova escolhe a plaquinha pela tela', () => {
  let dono: { Authorization: string };
  let lojaDoGrupo: string;

  beforeEach(async () => {
    resetDbForTests();
    ensureCoreSchema();
    lojaDoGrupo = upsertCompany({ slug: 'loja-grupo-185', legalName: 'Loja Ltda', tradeName: 'Loja', kind: 'retail' });
    const donoId = await upsertUser({ login: 'DONO185', displayName: 'Dono', password: SENHA });
    linkUserToCompany(donoId, lojaDoGrupo, 'gestor', true);
    dono = await entrar('DONO185');
  });

  async function criar(corpo: Record<string, unknown>): Promise<request.Response> {
    return request(app)
      .post('/api/v1/core/companies')
      .set(dono)
      .send({
        legalName: `Operação ${randomUUID().slice(0, 6)} Ltda`,
        manager: {
          login: `GER.${randomUUID().slice(0, 6)}`,
          displayName: 'Gerente',
          password: SENHA,
        },
        ...corpo,
      });
  }

  it('oficina de mobilidade nasce usando plaquinha, e o gerente dela gera o primeiro lote sem UPDATE à mão', async () => {
    const res = await request(app)
      .post('/api/v1/core/companies')
      .set(dono)
      .send({
        legalName: 'Sétima Oficina Ltda',
        tradeName: 'Sétima Oficina',
        kind: 'workshop',
        manager: { login: 'GER.SETIMA', displayName: 'Gerente da Sétima', password: SENHA },
      });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.company.usesEquipmentTags).toBe(true);
    expect(flag(res.body.company.id)).toBe(1);

    // A senha que o dono definiu é PROVISÓRIA (GAP-PRD-202): o gerente troca
    // antes do primeiro gesto, como na tela.
    const provisoria = await entrar('GER.SETIMA');
    const troca = await request(app)
      .post('/api/v1/auth/password')
      .set(provisoria)
      .send({ currentPassword: SENHA, newPassword: 'Setima@Nova2026' });
    expect(troca.status, JSON.stringify(troca.body)).toBe(204);
    const login = await request(app).post('/api/v1/auth/login').send({ login: 'GER.SETIMA', password: 'Setima@Nova2026' });
    expect(login.status, JSON.stringify(login.body)).toBe(200);
    const gerente = { Authorization: `Bearer ${login.body.accessToken}` };
    const lote = await request(app)
      .post('/api/v1/core/equipment-tags/batches')
      .set(gerente)
      .send({ quantidade: 3 });
    // Antes: 409 CORE_COMPANY_NO_TAGS, "UPDATE manual".
    expect(lote.status, JSON.stringify(lote.body)).toBe(201);
  });

  it('celular e loja nascem sem; a escolha explícita vence o padrão; escolha malformada é 400 sem nada nascer', async () => {
    const celulares = await criar({ kind: 'workshop', workshopKind: 'phones' });
    expect(celulares.status, JSON.stringify(celulares.body)).toBe(201);
    expect(flag(celulares.body.company.id)).toBe(0);

    const loja = await criar({ kind: 'retail' });
    expect(flag(loja.body.company.id)).toBe(0);

    // A loja que vende moto (uma PJ nova) liga na criação.
    const lojaDeMoto = await criar({ kind: 'retail', usesEquipmentTags: true });
    expect(lojaDeMoto.body.company.usesEquipmentTags).toBe(true);
    expect(flag(lojaDeMoto.body.company.id)).toBe(1);

    // A oficina de mobilidade que não quer, desliga na criação.
    const semPlaquinha = await criar({ kind: 'workshop', usesEquipmentTags: false });
    expect(flag(semPlaquinha.body.company.id)).toBe(0);

    const antes = (getConnection().prepare('SELECT COUNT(*) AS n FROM core_companies').get() as { n: number }).n;
    const ruim = await criar({ kind: 'workshop', usesEquipmentTags: 'sim' });
    expect(ruim.status).toBe(400);
    expect(ruim.body.error.code).toBe('CORE_COMPANY_TAGS_INVALID');
    expect((getConnection().prepare('SELECT COUNT(*) AS n FROM core_companies').get() as { n: number }).n).toBe(antes);
  });

  it('quem responde pelo grupo liga e desliga depois; a lista mostra; desligar com adesivo no pool é recusado', async () => {
    const oficina = await criar({ kind: 'workshop', usesEquipmentTags: false });
    const id = String(oficina.body.company.id);

    const lista = await request(app).get('/api/v1/core/companies').set(dono);
    expect(lista.body.items.find((c: { id: string }) => c.id === id).usesEquipmentTags).toBe(false);

    const liga = await request(app)
      .patch(`/api/v1/core/companies/${id}/equipment-tags`)
      .set(dono)
      .send({ enabled: true });
    expect(liga.status, JSON.stringify(liga.body)).toBe(200);
    expect(liga.body.usesEquipmentTags).toBe(true);
    expect(flag(id)).toBe(1);
    const auditoria = getConnection()
      .prepare(
        "SELECT detail FROM core_audit_log WHERE action = 'company.equipment_tags.update' AND company_id = ?",
      )
      .get(id) as { detail: string } | undefined;
    expect(JSON.parse(auditoria!.detail)).toMatchObject({ antes: false, depois: true });

    // Um lote gerado e ainda no pool: desligar agora deixaria adesivo sem caminho.
    getConnection()
      .prepare(
        `INSERT INTO core_equipment_tags (id, company_id, public_id, public_token, status, created_at, updated_at)
         VALUES (?, ?, 999001, ?, 'disponivel', ?, ?)`,
      )
      .run(randomUUID(), id, randomUUID(), new Date().toISOString(), new Date().toISOString());
    const desligaComPool = await request(app)
      .patch(`/api/v1/core/companies/${id}/equipment-tags`)
      .set(dono)
      .send({ enabled: false });
    expect(desligaComPool.status).toBe(409);
    expect(desligaComPool.body.error.code).toBe('CORE_COMPANY_TAGS_PENDING');
    expect(flag(id)).toBe(1);

    getConnection().prepare("UPDATE core_equipment_tags SET status = 'danificada' WHERE company_id = ?").run(id);
    const desliga = await request(app)
      .patch(`/api/v1/core/companies/${id}/equipment-tags`)
      .set(dono)
      .send({ enabled: false });
    expect(desliga.status).toBe(200);
    expect(flag(id)).toBe(0);

    const ruim = await request(app)
      .patch(`/api/v1/core/companies/${id}/equipment-tags`)
      .set(dono)
      .send({ enabled: 'talvez' });
    expect(ruim.status).toBe(400);
  });

  it('o gerente da operação não liga plaquinha: é de quem responde pelo grupo', async () => {
    const oficina = await criar({ kind: 'workshop', usesEquipmentTags: false });
    const gerente = await entrar(String(oficina.body.manager.login));
    const res = await request(app)
      .patch(`/api/v1/core/companies/${oficina.body.company.id}/equipment-tags`)
      .set(gerente)
      .send({ enabled: true });
    expect(res.status).toBe(403);
    expect(flag(oficina.body.company.id)).toBe(0);

    const inexistente = await request(app)
      .patch(`/api/v1/core/companies/${randomUUID()}/equipment-tags`)
      .set(dono)
      .send({ enabled: true });
    expect(inexistente.status).toBe(404);
  });
});

// ----------------------------------------------------- GAP-PRD-190 e GAP-PRD-107

describe('GAP-PRD-190 — a PJ Motors reimprime a plaquinha da moto que vende', () => {
  let pj: string;
  let oficina: string;
  let outraLoja: string;
  let mobilidade: string;
  let gerentePj: { Authorization: string };
  let gerenteOficina: { Authorization: string };
  let caixaPj: { Authorization: string };
  let gerenteOutra: { Authorization: string };
  let unitId: string;
  let equipamento: { id: string; public_id: number; public_token: string };

  beforeEach(async () => {
    resetDbForTests();
    ensureCoreSchema();
    pj = upsertCompany({ slug: 'pj-190', legalName: 'PJ Ltda', tradeName: 'PJ Motors 190', kind: 'retail' });
    oficina = upsertCompany({ slug: 'oficina-190', legalName: 'Oficina Ltda', tradeName: 'Oficina 190', kind: 'workshop' });
    outraLoja = upsertCompany({ slug: 'outra-190', legalName: 'Outra Ltda', tradeName: 'Outra', kind: 'retail' });
    getConnection()
      .prepare('UPDATE core_companies SET uses_equipment_tags = 1 WHERE id IN (?, ?, ?)')
      .run(pj, oficina, outraLoja);
    mobilidade = bancada(oficina, 'mob-190');

    const ger = await upsertUser({ login: 'GER.PJ190', displayName: 'Gerente PJ', password: SENHA });
    linkUserToCompany(ger, pj, 'gerente_loja', true);
    const mec = await upsertUser({ login: 'GER.OF190', displayName: 'Gerente Oficina', password: SENHA });
    linkUserToCompany(mec, oficina, 'gerente_oficina', true);
    const cx = await upsertUser({ login: 'CX.PJ190', displayName: 'Caixa PJ', password: SENHA });
    linkUserToCompany(cx, pj, 'operador_caixa_loja', true);
    const out = await upsertUser({ login: 'GER.OUT190', displayName: 'Gerente Outra', password: SENHA });
    linkUserToCompany(out, outraLoja, 'gerente_loja', true);
    getConnection()
      .prepare(
        `INSERT INTO core_workshop_members (id, workshop_id, user_id, created_at) VALUES (?, ?, ?, ?)`,
      )
      .run(randomUUID(), mobilidade, mec, new Date().toISOString());

    gerentePj = await entrar('GER.PJ190');
    gerenteOficina = await entrar('GER.OF190');
    caixaPj = await entrar('CX.PJ190');
    gerenteOutra = await entrar('GER.OUT190');

    const moto = createProduct(pj, { name: 'Shineray Jet 50', priceCents: 900_000 }).id;
    updateProduct(pj, moto, { serialized: true });
    [unitId] = createUnits(pj, moto, 1, { entryReferenceType: 'ajuste', entryReferenceId: 'e190' });
    applyMovement({
      companyId: pj,
      productId: moto,
      movementType: 'in',
      quantity: 1,
      referenceType: 'ajuste',
      referenceId: 'e190',
      unitIds: [unitId],
    });
    const criado = createEquipment({
      companyId: oficina,
      workshopId: mobilidade,
      userId: mec,
      origin: 'INTERNAL_PJ_MOTORS',
      brand: 'Shineray',
      model: 'Jet 50',
    });
    equipamento = { id: criado.id, public_id: criado.public_id, public_token: criado.public_token };
    vincularUnidade({ companyId: pj, unitId, equipmentId: criado.id, userId: ger });
  });

  it('antes, pelas rotas de etiqueta, a PJ não encontrava a moto (a máquina vive na Oficina)', async () => {
    const velha = await request(app)
      .post('/api/v1/core/labels/equipment/sheet')
      .set(gerentePj)
      .send({ equipmentIds: [equipamento.id] });
    expect(velha.status).toBe(409);
    expect(velha.body.error.details.problemas[0].motivo).toBe('Equipamento não encontrado.');
  });

  it('pela unidade, a folha sai com o MESMO número e o MESMO QR, e o histórico da máquina registra quem reimprimiu', async () => {
    const res = await request(app)
      .post(`/api/v1/core/units/${unitId}/equipment/sheet`)
      .set(gerentePj)
      .send({});
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const rotulo = `#${String(equipamento.public_id).padStart(4, '0')}`;
    expect(res.body.publicIdLabel).toBe(rotulo);
    expect(res.body.html).toContain(rotulo);
    // Reimprimir não troca: o token da máquina é o mesmo de antes.
    const token = (
      getConnection().prepare('SELECT public_token FROM core_equipment WHERE id = ?').get(equipamento.id) as {
        public_token: string;
      }
    ).public_token;
    expect(token).toBe(equipamento.public_token);
    // A credencial não viaja no JSON além do desenho do QR.
    expect(JSON.stringify({ ...res.body, html: '' })).not.toContain(equipamento.public_token);

    const evento = getConnection()
      .prepare(
        "SELECT company_id, description FROM core_equipment_events WHERE equipment_id = ? AND event_type = 'label_printed'",
      )
      .get(equipamento.id) as { company_id: string; description: string };
    expect(evento.company_id).toBe(oficina);
    expect(evento.description).toContain('PJ Motors 190');
    const auditoria = getConnection()
      .prepare("SELECT company_id FROM core_audit_log WHERE action = 'unit.equipment.label.reprint'")
      .get() as { company_id: string };
    expect(auditoria.company_id).toBe(pj);
  });

  it('as recusas: unidade sem plaquinha 409, unidade de outra loja 404, caixa 403, loja sem plaquinha 409', async () => {
    const produto = createProduct(pj, { name: 'Outra moto', priceCents: 100 }).id;
    updateProduct(pj, produto, { serialized: true });
    const [solta] = createUnits(pj, produto, 1, { entryReferenceType: 'ajuste', entryReferenceId: 'e2' });
    const semPlaquinha = await request(app)
      .post(`/api/v1/core/units/${solta}/equipment/sheet`)
      .set(gerentePj)
      .send({});
    expect(semPlaquinha.status).toBe(409);
    expect(semPlaquinha.body.error.code).toBe('CORE_UNIT_WITHOUT_TAG');

    const deOutraLoja = await request(app)
      .post(`/api/v1/core/units/${unitId}/equipment/sheet`)
      .set(gerenteOutra)
      .send({});
    expect(deOutraLoja.status).toBe(404);

    const doCaixa = await request(app)
      .post(`/api/v1/core/units/${unitId}/equipment/sheet`)
      .set(caixaPj)
      .send({});
    expect(doCaixa.status).toBe(403);

    getConnection().prepare('UPDATE core_companies SET uses_equipment_tags = 0 WHERE id = ?').run(pj);
    const semRegra = await request(app)
      .post(`/api/v1/core/units/${unitId}/equipment/sheet`)
      .set(gerentePj)
      .send({});
    expect(semRegra.status).toBe(409);
    expect(semRegra.body.error.code).toBe('CORE_COMPANY_NO_TAGS');
  });

  it('GAP-PRD-107 — a ficha diz se a máquina pode trocar de plaquinha (empresa no pool e bancada com QR)', async () => {
    const ficha = await request(app).get(`/api/v1/core/equipment/${equipamento.id}`).set(gerenteOficina);
    expect(ficha.status, JSON.stringify(ficha.body)).toBe(200);
    expect(ficha.body.plaquinha).toEqual({ empresaUsa: true, bancadaUsa: true });

    getConnection().prepare('UPDATE core_companies SET uses_equipment_tags = 0 WHERE id = ?').run(oficina);
    getConnection().prepare("UPDATE core_workshops SET kind = 'phones' WHERE id = ?").run(mobilidade);
    const depois = await request(app).get(`/api/v1/core/equipment/${equipamento.id}`).set(gerenteOficina);
    expect(depois.body.plaquinha).toEqual({ empresaUsa: false, bancadaUsa: false });
  });
});
