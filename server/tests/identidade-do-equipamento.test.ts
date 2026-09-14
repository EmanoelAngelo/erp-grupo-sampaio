/**
 * ============================================================================
 * A IDENTIDADE DA MÁQUINA — tipo, placa, km, fotos e correção auditada
 * (GAP-PRD-106)
 * ============================================================================
 *
 * ## O que a auditoria mediu
 *
 * `core_equipment` sem km, sem placa, sem fotos; categoria em texto livre; e
 * marca, modelo, chassi e série sem porta de edição (`PATCH /equipment/:id` era
 * estreito: garantia e montagem). O chassi digitado errado virava plaquinha
 * errada para sempre — o conserto era a unidade da loja (só moto da PJ) ou SQL.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createApp } from '../src/app.js';
import { resetDbForTests } from '../src/db/database.js';
import { getConnection } from '../src/db/sqlite.js';
import { upsertCompany } from '../src/services/auth/IdentityService.js';
import { createProduct, updateProduct } from '../src/services/core/CatalogService.js';
import { applyMovement } from '../src/services/core/InventoryService.js';
import { createUnits } from '../src/services/core/ProductUnitService.js';
import { vincularUnidade } from '../src/services/core/EquipmentStockLink.js';
import { equipmentPhotosDir } from '../src/services/core/EquipmentPhotoService.js';
import { loginForTest } from './helpers/auth.js';

const app = createApp();
const OFICINA = 'oficina-id106';
const OUTRA = 'outra-id106';
const CPF = '529.982.247-25';
/** Um PNG de 1x1, o menor arquivo de imagem válido. */
const PNG =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

interface Ator {
  auth: { Authorization: string };
  userId: string;
}
let gerente: Ator;
let mecanico: Ator;
let atendente: Ator;
let gerenteOutra: Ator;
let bancada: string;

async function entrar(userId: string, empresa: string, perfil: string): Promise<Ator> {
  const res = await loginForTest(app, { userId, companyId: empresa, profileCodes: [perfil] });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return { auth: { Authorization: `Bearer ${res.body.accessToken as string}` }, userId: String(res.body.user.id) };
}

function linha(id: string): Record<string, unknown> {
  return getConnection().prepare('SELECT * FROM core_equipment WHERE id = ?').get(id) as Record<string, unknown>;
}

function eventos(id: string): { event_type: string; description: string | null }[] {
  return getConnection()
    .prepare('SELECT event_type, description FROM core_equipment_events WHERE equipment_id = ? ORDER BY created_at, rowid')
    .all(id) as unknown as { event_type: string; description: string | null }[];
}

async function cadastrar(extra: Record<string, unknown> = {}, ator: Ator = gerente): Promise<request.Response> {
  return request(app)
    .post('/api/v1/core/equipment')
    .set(ator.auth)
    .send({ origin: 'INTERNAL_PJ_MOTORS', brand: 'Shineray', model: 'Jet 50', ...extra });
}

beforeEach(async () => {
  resetDbForTests();
  gerente = await entrar('ger-106', OFICINA, 'gerente_oficina');
  mecanico = await entrar('mec-106', OFICINA, 'mecanico');
  atendente = await entrar('at-106', OFICINA, 'atendente');
  gerenteOutra = await entrar('ger-outra-106', OUTRA, 'gerente_oficina');
  bancada = randomUUID();
  getConnection()
    .prepare(
      `INSERT INTO core_workshops (id, company_id, slug, name, kind, active, created_at)
       VALUES (?, ?, ?, 'Mobilidade', 'mobility', 1, ?)`,
    )
    .run(bancada, OFICINA, `mob-${bancada}`, new Date().toISOString());
  getConnection()
    .prepare('INSERT INTO core_workshop_members (id, workshop_id, user_id, created_at) VALUES (?, ?, ?, ?)')
    .run(randomUUID(), bancada, mecanico.userId, new Date().toISOString());
});

describe('GAP-PRD-106 — o cadastro nasce com tipo, placa e quilometragem', () => {
  it('tipo do vocabulário, placa normalizada e km com data', async () => {
    const res = await cadastrar({ category: 'moto', plate: 'abc-1d23', odometerKm: 1200 });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    // O token do QR não sai nem na resposta de criação — como em toda outra rota.
    expect(res.body.public_token).toBeUndefined();
    const l = linha(res.body.id);
    expect(l).toMatchObject({ category: 'moto', plate: 'ABC1D23', odometer_km: 1200 });
    expect(l.odometer_at).toBeTruthy();
  });

  it('as recusas do cadastro: tipo livre, placa torta, celular com placa, "Outro" sem descrição, placa repetida', async () => {
    const livre = await cadastrar({ category: 'Moto elétrica' });
    expect(livre.status).toBe(400);
    expect(livre.body.error.code).toBe('CORE_EQUIPMENT_CATEGORY_INVALID');

    const torta = await cadastrar({ category: 'moto', plate: 'AB-12' });
    expect(torta.body.error.code).toBe('CORE_EQUIPMENT_PLATE_INVALID');

    const celular = await cadastrar({ category: 'celular', plate: 'ABC1234' });
    expect(celular.status).toBe(400);
    expect(celular.body.error.code).toBe('CORE_EQUIPMENT_FIELD_NOT_APPLICABLE');

    const outro = await cadastrar({ category: 'outro', brand: '', model: '' });
    expect(outro.body.error.code).toBe('CORE_EQUIPMENT_DESCRIPTION_REQUIRED');

    const primeira = await cadastrar({ category: 'moto', plate: 'ABC1234' });
    expect(primeira.status).toBe(201);
    const repetida = await cadastrar({ category: 'moto', plate: 'abc 1234' });
    expect(repetida.status).toBe(409);
    expect(repetida.body.error.code).toBe('CORE_EQUIPMENT_DUPLICATE_IDENTITY');
    expect(repetida.body.error.message).toContain(primeira.body.publicIdLabel);

    // O cadastro sem tipo continua valendo (a máquina chega antes dos papéis).
    expect((await cadastrar({})).status).toBe(201);
  });
});

describe('GAP-PRD-106 — a correção de identidade pela ficha', () => {
  it('corrige chassi e modelo com motivo; o histórico guarda antes e depois; auditoria e central recebem', async () => {
    const criado = await cadastrar({ category: 'moto', chassis: '9C2JC4110ER000001' });
    const id = String(criado.body.id);

    const res = await request(app)
      .patch(`/api/v1/core/equipment/${id}/identidade`)
      .set(mecanico.auth)
      .send({ chassis: '9C2JC4110ER000011', model: 'Jet 50 Plus', motivo: 'Chassi digitado errado na entrada' });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.public_token).toBeUndefined();
    expect(linha(id)).toMatchObject({ chassis: '9C2JC4110ER000011', model: 'Jet 50 Plus' });

    const evento = eventos(id).at(-1)!;
    expect(evento.event_type).toBe('identidade_corrigida');
    expect(evento.description).toContain('chassi: 9C2JC4110ER000001 → 9C2JC4110ER000011');
    expect(evento.description).toContain('modelo: Jet 50 → Jet 50 Plus');
    expect(evento.description).toContain('Chassi digitado errado na entrada');

    const auditoria = getConnection()
      .prepare("SELECT detail FROM core_audit_log WHERE action = 'equipment.identity.update' AND entity_id = ?")
      .get(id) as { detail: string };
    expect(JSON.parse(auditoria.detail).mudancas).toHaveLength(2);
    const central = getConnection()
      .prepare(
        "SELECT payload FROM core_outbox WHERE event_type = 'equipment.upserted' AND aggregate_id = ? ORDER BY rowid DESC LIMIT 1",
      )
      .get(id) as { payload: string };
    expect(JSON.parse(central.payload)).toMatchObject({ model: 'Jet 50 Plus' });
    expect(JSON.parse(central.payload).public_token).toBeUndefined();
  });

  it('identidade sem motivo é 400 e nada muda; km novo entra sem motivo; km que volta pede motivo', async () => {
    const criado = await cadastrar({ category: 'moto', odometerKm: 1000 });
    const id = String(criado.body.id);
    const semMotivo = await request(app)
      .patch(`/api/v1/core/equipment/${id}/identidade`)
      .set(mecanico.auth)
      .send({ model: 'Outro modelo' });
    expect(semMotivo.status).toBe(400);
    expect(semMotivo.body.error.code).toBe('CORE_REASON_REQUIRED');
    expect(linha(id).model).toBe('Jet 50');

    const km = await request(app)
      .patch(`/api/v1/core/equipment/${id}/identidade`)
      .set(mecanico.auth)
      .send({ odometerKm: 1500 });
    expect(km.status, JSON.stringify(km.body)).toBe(200);
    expect(linha(id).odometer_km).toBe(1500);
    expect(eventos(id).at(-1)).toMatchObject({ event_type: 'km_registrado' });

    const volta = await request(app)
      .patch(`/api/v1/core/equipment/${id}/identidade`)
      .set(mecanico.auth)
      .send({ odometerKm: 900 });
    expect(volta.status).toBe(400);
    const comMotivo = await request(app)
      .patch(`/api/v1/core/equipment/${id}/identidade`)
      .set(mecanico.auth)
      .send({ odometerKm: 900, motivo: 'Leitura anterior digitada com um zero a mais' });
    expect(comMotivo.status).toBe(200);
    expect(linha(id).odometer_km).toBe(900);
  });

  it('chassi e placa de outra plaquinha são recusados dizendo qual; mandar o mesmo valor não gera evento', async () => {
    const a = await cadastrar({ category: 'moto', chassis: 'CHASSI-A', plate: 'AAA1111' });
    const b = await cadastrar({ category: 'moto', chassis: 'CHASSI-B', plate: 'BBB2222' });
    const chassi = await request(app)
      .patch(`/api/v1/core/equipment/${b.body.id}/identidade`)
      .set(gerente.auth)
      .send({ chassis: 'CHASSI-A', motivo: 'x' });
    expect(chassi.status).toBe(409);
    expect(chassi.body.error.message).toContain(a.body.publicIdLabel);
    const placa = await request(app)
      .patch(`/api/v1/core/equipment/${b.body.id}/identidade`)
      .set(gerente.auth)
      .send({ plate: 'aaa-1111', motivo: 'x' });
    expect(placa.status).toBe(409);

    const antes = eventos(String(b.body.id)).length;
    const igual = await request(app)
      .patch(`/api/v1/core/equipment/${b.body.id}/identidade`)
      .set(gerente.auth)
      .send({ chassis: 'CHASSI-B' });
    expect(igual.status).toBe(200);
    expect(igual.body.mudancas).toEqual([]);
    expect(eventos(String(b.body.id))).toHaveLength(antes);
  });

  it('o tipo antigo em texto livre é trazido ao vocabulário pela correção', async () => {
    const criado = await cadastrar({});
    const id = String(criado.body.id);
    getConnection().prepare("UPDATE core_equipment SET category = 'Moto, bicicleta elétrica' WHERE id = ?").run(id);
    const res = await request(app)
      .patch(`/api/v1/core/equipment/${id}/identidade`)
      .set(gerente.auth)
      .send({ category: 'bicicleta_eletrica', motivo: 'Padronizando o tipo' });
    expect(res.status).toBe(200);
    expect(linha(id).category).toBe('bicicleta_eletrica');
    expect(eventos(id).at(-1)!.description).toContain('tipo: Moto, bicicleta elétrica → Bicicleta elétrica');
  });

  it('a regra do tipo vale sobre o estado final: virar celular com placa é recusado', async () => {
    const criado = await cadastrar({ category: 'moto', plate: 'CCC3C33' });
    const res = await request(app)
      .patch(`/api/v1/core/equipment/${criado.body.id}/identidade`)
      .set(gerente.auth)
      .send({ category: 'celular', motivo: 'x' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('CORE_EQUIPMENT_FIELD_NOT_APPLICABLE');
    expect(linha(String(criado.body.id)).category).toBe('moto');
  });

  it('atendente 403; outra empresa 404; corpo vazio 400', async () => {
    const criado = await cadastrar({ category: 'moto' });
    const doBalcao = await request(app)
      .patch(`/api/v1/core/equipment/${criado.body.id}/identidade`)
      .set(atendente.auth)
      .send({ model: 'x', motivo: 'x' });
    expect(doBalcao.status).toBe(403);
    const deFora = await request(app)
      .patch(`/api/v1/core/equipment/${criado.body.id}/identidade`)
      .set(gerenteOutra.auth)
      .send({ model: 'x', motivo: 'x' });
    expect(deFora.status).toBe(404);
    const vazio = await request(app)
      .patch(`/api/v1/core/equipment/${criado.body.id}/identidade`)
      .set(gerente.auth)
      .send({ motivo: 'x' });
    expect(vazio.status).toBe(400);
  });
});

describe('GAP-PRD-106 — máquina vinculada à loja: chassi, motor e série são da unidade', () => {
  it('a ficha diz o vínculo; corrigir o chassi pela ficha é recusado nomeando a loja; o modelo passa', async () => {
    const criado = await cadastrar({ category: 'moto', chassis: 'CH-VINC-1' });
    const id = String(criado.body.id);
    const pj = upsertCompany({ slug: 'pj-106', legalName: 'PJ Ltda', tradeName: 'PJ Motors 106', kind: 'retail' });
    getConnection().prepare('UPDATE core_companies SET uses_equipment_tags = 1 WHERE id IN (?, ?)').run(pj, OFICINA);
    const moto = createProduct(pj, { name: 'Jet 50', priceCents: 1000 }).id;
    updateProduct(pj, moto, { serialized: true });
    const [unitId] = createUnits(pj, moto, 1, { entryReferenceType: 'ajuste', entryReferenceId: 'e106' });
    applyMovement({ companyId: pj, productId: moto, movementType: 'in', quantity: 1, referenceType: 'ajuste', referenceId: 'e106', unitIds: [unitId] });
    vincularUnidade({ companyId: pj, unitId, equipmentId: id, userId: gerente.userId, confirmarPelaUnidade: true });

    const ficha = await request(app).get(`/api/v1/core/equipment/${id}`).set(gerente.auth);
    expect(ficha.body.vinculoDeEstoque).toMatchObject({ unitId, companyName: 'PJ Motors 106' });

    const chassi = await request(app)
      .patch(`/api/v1/core/equipment/${id}/identidade`)
      .set(gerente.auth)
      .send({ chassis: 'CH-OUTRO', motivo: 'x' });
    expect(chassi.status).toBe(409);
    expect(chassi.body.error.code).toBe('CORE_EQUIPMENT_IDENTITY_BY_UNIT');
    expect(chassi.body.error.message).toContain('PJ Motors 106');

    const modelo = await request(app)
      .patch(`/api/v1/core/equipment/${id}/identidade`)
      .set(gerente.auth)
      .send({ model: 'Jet 50 2026', motivo: 'Modelo do ano' });
    expect(modelo.status).toBe(200);
  });
});

describe('GAP-PRD-106 — fotos da máquina e contato do dono na ficha', () => {
  it('o balcão sobe, a ficha lista, o arquivo é servido; a bancada apaga; as recusas', async () => {
    const criado = await cadastrar({ category: 'moto' });
    const id = String(criado.body.id);

    const sobe = await request(app)
      .post(`/api/v1/core/equipment/${id}/photos`)
      .set(atendente.auth)
      .send({ dataUrl: PNG, kind: 'painel', caption: 'Painel na entrada' });
    expect(sobe.status, JSON.stringify(sobe.body)).toBe(201);
    // O link volta ASSINADO, como o da foto da OS (GAP-PRD-184 na junção das
    // frentes): o caminho cru não abre mais nada.
    expect(sobe.body.url).toMatch(/^\/uploads\/equipamentos\/[0-9a-f-]+\.png\?e=\d+&s=[\w-]+$/);
    const caminho = String(sobe.body.url).split('?')[0];
    const nome = caminho.split('/').pop()!;
    expect(existsSync(join(equipmentPhotosDir(), nome))).toBe(true);

    const cru = await request(app).get(caminho);
    expect(cru.status).toBe(403);
    const servido = await request(app).get(String(sobe.body.url));
    expect(servido.status).toBe(200);

    const lista = await request(app).get(`/api/v1/core/equipment/${id}/photos`).set(mecanico.auth);
    expect(lista.body.items).toHaveLength(1);
    expect(lista.body.items[0].url).toMatch(/\?e=\d+&s=[\w-]+$/);
    expect(lista.body.items[0]).toMatchObject({ kind: 'painel', caption: 'Painel na entrada' });

    const formato = await request(app)
      .post(`/api/v1/core/equipment/${id}/photos`)
      .set(atendente.auth)
      .send({ dataUrl: 'data:application/pdf;base64,AAAA' });
    expect(formato.status).toBe(400);
    const tipo = await request(app)
      .post(`/api/v1/core/equipment/${id}/photos`)
      .set(atendente.auth)
      .send({ dataUrl: PNG, kind: 'selfie' });
    expect(tipo.status).toBe(400);
    const deFora = await request(app)
      .post(`/api/v1/core/equipment/${id}/photos`)
      .set(gerenteOutra.auth)
      .send({ dataUrl: PNG });
    expect(deFora.status).toBe(404);

    const apagaBalcao = await request(app)
      .delete(`/api/v1/core/equipment/${id}/photos/${sobe.body.id}`)
      .set(atendente.auth);
    expect(apagaBalcao.status).toBe(403);
    const apaga = await request(app)
      .delete(`/api/v1/core/equipment/${id}/photos/${sobe.body.id}`)
      .set(mecanico.auth);
    expect(apaga.status).toBe(204);
    expect(existsSync(join(equipmentPhotosDir(), nome))).toBe(false);
  });

  it('o teto por máquina é doze fotos', async () => {
    const criado = await cadastrar({ category: 'moto' });
    for (let i = 0; i < 12; i += 1) {
      const r = await request(app)
        .post(`/api/v1/core/equipment/${criado.body.id}/photos`)
        .set(gerente.auth)
        .send({ dataUrl: PNG });
      expect(r.status).toBe(201);
    }
    const decima3 = await request(app)
      .post(`/api/v1/core/equipment/${criado.body.id}/photos`)
      .set(gerente.auth)
      .send({ dataUrl: PNG });
    expect(decima3.status).toBe(409);
    expect(decima3.body.error.code).toBe('CORE_PHOTOS_LIMIT');
  });

  it('a ficha traz o telefone do dono', async () => {
    const cliente = await request(app)
      .post('/api/v1/core/customers')
      .set(gerente.auth)
      .send({ name: 'Seu Jorge', document: CPF, phone: '53 98888-0000' });
    expect(cliente.status, JSON.stringify(cliente.body)).toBe(201);
    const criado = await cadastrar({ origin: 'EXTERNAL_CUSTOMER', ownerCustomerId: cliente.body.id, category: 'moto' });
    const ficha = await request(app).get(`/api/v1/core/equipment/${criado.body.id}`).set(gerente.auth);
    expect(ficha.body.ownerName).toBe('Seu Jorge');
    expect(ficha.body.ownerPhone).toBe('53 98888-0000');
    expect(ficha.body.vinculoDeEstoque).toBeNull();
  });
});
