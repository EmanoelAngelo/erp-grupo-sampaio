/**
 * ============================================================================
 * A PLAQUINHA QUE A PJ MOTORS GERA ENTRA NA MOTO — e o QR dela abre a moto
 * ============================================================================
 *
 * ## O buraco que isto fecha
 *
 * O dono decidiu que plaquinha com QR e número é SÓ da PJ Motors, e a PJ
 * passou a gerar o lote, imprimir a folha e liberar sem bancada. Mas a
 * plaquinha liberada só virava `associada` quando uma MÁQUINA era cadastrada
 * com ela (`createEquipment`), e cadastrar máquina exige bancada — que a PJ não
 * tem. O adesivo colado na moto do pátio ficava `disponivel` para sempre, e o
 * QR dele respondia 404: a página pública só conhecia o token de máquina. A
 * plaquinha que a PJ gera nunca podia ser usada.
 *
 * Agora o adesivo entra na UNIDADE de estoque (`core_equipment_tags.unit_id`),
 * sem máquina e sem bancada falsas, e a página pública resolve o token por esse
 * vínculo.
 *
 * ## O que este arquivo prova, pelas rotas de verdade, num banco descartável
 *
 *   1. antes de colar, o QR da plaquinha gerada ou liberada é o MESMO 404 de um
 *      token inventado;
 *   2. o gestor da PJ (`gerente_loja`, o modelo do `ADMIN-PJ MOTORS`) cola o
 *      adesivo liberado na moto do estoque, e o mesmo QR abre a moto sem
 *      sessão — sem nascer máquina nem bancada para a PJ;
 *   3. a lista de unidades, o pool e a fila "sem plaquinha" sabem do adesivo;
 *   4. cada recusa do colar, uma por uma, sem gravar nada;
 *   5. reimprimir pela unidade (mesmo número, mesmo QR), soltar (o QR volta ao
 *      404) e trocar o adesivo estragado (o QR velho morre na hora);
 *   6. a venda da moto com plaquinha da PJ segue como qualquer venda; a baixa
 *      tira a página do ar;
 *   7. plaquinha forçada fora da PJ não abre página;
 *   8. o caixa do PDV da PJ (`operador_caixa_loja`, o login `PJ MOTORS`) não
 *      cola, não solta, não troca e não imprime plaquinha pela fila;
 *   9. Preço Justo, Oficina (COM bancada) e Gringa levam 403
 *      `CORE_COMPANY_NO_TAGS` nas três rotas novas, sem dado da PJ e sem gravar
 *      nada — com a marca desligada ou ligada no banco;
 *  10. (resíduo) o modelo "Estoque" — `inventory.units.manage` sem a leitura do
 *      pool — acha os adesivos livres pela leitura estreita da unidade
 *      (GET /units/:id/tag/livres), cola e troca, e o pool continua fechado a
 *      ele; a leitura só mostra o que o colar aceita, e segue a regra da
 *      empresa e a do PDV como as vizinhas;
 *  11. (resíduo) a troca confere as duas escritas: adesivo novo vazio é 400, a
 *      "disponível" presa a outra moto ou a uma máquina não é arrancada, e a
 *      velha que deixou a moto no meio da escrita desfaz a troca inteira;
 *  12. (resíduo) a venda, a devolução e o cancelamento pelas ROTAS de verdade,
 *      com caixa aberto: o QR da moto com o adesivo vai de "Disponível na loja"
 *      a vendida e volta, e a moto com a plaquinha da máquina segue igual.
 *
 * ## As mordidas (cada uma deixa um caso vermelho)
 *
 *   - tire o fallback da unidade em `publicEquipmentByToken` → caso 2 (404);
 *   - tire `t.status = 'associada'` do fallback → a troca (QR velho responde);
 *   - tire o filtro do estado da unidade → a baixa (QR da baixada responde);
 *   - tire a conferência do slug → a plaquinha forçada fora da PJ responde;
 *   - tire `exigirEmpresaComPlaquinha` de `PlaquinhaDaPjNaUnidade.ts` → o laço
 *     das outras empresas (404/409 no lugar de 403);
 *   - tire `requireCapability` de uma rota nova → o caso do PDV;
 *   - tire a linha do EQUIPMENT_QR_TAG em POST /print/jobs → o PDV imprime
 *     (404 da máquina no lugar do 403);
 *   - tire a recusa `CORE_UNIT_ALREADY_TAGGED` de `vincularUnidade` ou de
 *     `vincularPlaquinhaDoPool` → as recusas (201);
 *   - volte a reimpressão pela unidade → 409 `CORE_UNIT_WITHOUT_TAG`;
 *   - volte o NOT EXISTS do resumo → a fila não desce;
 *   - tire `requireCapability` da leitura dos livres → o PDV lê (200);
 *   - tire o filtro `unit_id IS NULL AND equipment_id IS NULL` da leitura → a
 *     "disponível" presa aparece na lista;
 *   - volte o id vazio da troca → 404 no lugar do 400;
 *   - volte a escrita da nova para `WHERE id = ? AND status = 'disponivel'` →
 *     a "disponível" presa é arrancada da outra moto (200);
 *   - tire a guarda da velha (`status = 'associada' AND unit_id = ?` com
 *     `changes === 1`) → a troca passa sobre a velha que já saiu (200).
 */
import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import type { Express } from 'express';
import { createApp } from '../src/app.js';
import { getConnection } from '../src/db/sqlite.js';
import { resetDbForTests } from '../src/db/database.js';
import { ensureOfficialTagCompanies, ensureOfficialWorkshops } from '../src/db/core-migrations.js';
import { createProduct, updateProduct } from '../src/services/core/CatalogService.js';
import { applyMovement } from '../src/services/core/InventoryService.js';
import { createUnits, identifyUnit } from '../src/services/core/ProductUnitService.js';
import { createEquipment } from '../src/services/core/EquipmentService.js';
import { vincularUnidade } from '../src/services/core/EquipmentStockLink.js';
import { cancelSale, createSale } from '../src/services/core/SalesService.js';
import { desenharQr } from '../src/services/core/Qr.js';
import { equipmentTagFormat } from '../src/services/core/EquipmentTagFormats.js';
import { publicBaseUrl } from '../src/services/core/PublicUrl.js';
import { loginForTest } from './helpers/auth.js';

let app: Express;

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
let mobilidade: string;

const PRECO = 1_500_000;
const agora = () => new Date().toISOString();
const db = () => getConnection();

async function entrar(userId: string, slug: string, perfil: string): Promise<Sessao> {
  const res = await loginForTest(app, { userId, companyId: slug, profileCodes: [perfil] });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return {
    id: String(res.body.company.id),
    auth: { Authorization: `Bearer ${res.body.accessToken}` },
    userId: String(res.body.user.id),
  };
}

/** O produto "Honda CG 160", controlado por unidade — um por empresa. */
const produtos = new Map<string, string>();
function produtoMoto(companyId: string): string {
  const ja = produtos.get(companyId);
  if (ja) return ja;
  const id = String(
    createProduct(companyId, { name: 'CG 160', brand: 'Honda', category: 'Moto', priceCents: PRECO }).id,
  );
  updateProduct(companyId, id, { serialized: true });
  produtos.set(companyId, id);
  return id;
}

/** Uma moto em estoque na empresa, com chassi lido no pátio. */
let sequenciaDeChassi = 0;
function motoEmEstoque(companyId: string): { unitId: string; productId: string; chassi: string } {
  const productId = produtoMoto(companyId);
  const chave = randomUUID();
  const [unitId] = createUnits(companyId, productId, 1, { entryReferenceType: 'ajuste', entryReferenceId: chave });
  applyMovement({
    companyId,
    productId,
    movementType: 'in',
    quantity: 1,
    referenceType: 'ajuste',
    referenceId: chave,
    unitIds: [unitId],
  });
  sequenciaDeChassi += 1;
  const chassi = `9C2KC1670NR${String(sequenciaDeChassi).padStart(6, '0')}`;
  identifyUnit(companyId, unitId, { chassis: chassi });
  return { unitId, productId, chassi };
}

/** Uma venda de balcão SEM cliente, como o PDV faz com a moto sem plaquinha de máquina. */
function venderSemCliente(companyId: string, userId: string, productId: string, unitId: string) {
  return createSale({
    companyId,
    userId,
    customerId: null,
    items: [{ productId, quantity: 1, unitIds: [unitId] }],
    payments: [{ method: 'dinheiro', amountCents: PRECO }],
    idempotencyKey: randomUUID(),
  });
}

interface Tag {
  id: string;
  public_id: number;
  public_token: string;
}

/** Gera, imprime e libera um lote pelas rotas de verdade — como a tela de Plaquinhas faz. */
async function loteLiberado(quantidade: number): Promise<Tag[]> {
  const lote = await request(app).post('/api/v1/core/equipment-tags/batches').set(pj.auth).send({ quantidade });
  expect(lote.status, JSON.stringify(lote.body)).toBe(201);
  const batchId = String(lote.body.batchId);
  const folha = await request(app).post('/api/v1/core/equipment-tags/sheet').set(pj.auth).send({ batchId });
  expect(folha.status, JSON.stringify(folha.body)).toBe(200);
  const libera = await request(app).post('/api/v1/core/equipment-tags/release').set(pj.auth).send({ batchId });
  expect(libera.status, JSON.stringify(libera.body)).toBe(200);
  return db()
    .prepare('SELECT id, public_id, public_token FROM core_equipment_tags WHERE batch_id = ? ORDER BY public_id')
    .all(batchId) as unknown as Tag[];
}

/** Um adesivo no pool, gravado como o banco o guarda (para os estados que a rota não produz). */
function plaquinhaNoPool(companyId: string, publicId: number, status: string): Tag {
  const id = randomUUID();
  db()
    .prepare(
      `INSERT INTO core_equipment_tags
         (id, company_id, public_id, public_token, status, printed_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(id, companyId, publicId, `tok-${id}`, status, agora(), agora(), agora());
  return { id, public_id: publicId, public_token: `tok-${id}` };
}

function estado(tagId: string): {
  status: string;
  unit_id: string | null;
  equipment_id: string | null;
  associated_at: string | null;
  damaged_reason: string | null;
} {
  return db()
    .prepare('SELECT status, unit_id, equipment_id, associated_at, damaged_reason FROM core_equipment_tags WHERE id = ?')
    .get(tagId) as never;
}

function unidade(unitId: string): { status: string; equipment_id: string | null } {
  return db().prepare('SELECT status, equipment_id FROM core_product_units WHERE id = ?').get(unitId) as never;
}

function contar(sql: string, ...params: unknown[]): number {
  return Number((db().prepare(sql).get(...(params as never[])) as { n: number }).n);
}

const maquinas = () => contar('SELECT COUNT(*) AS n FROM core_equipment');
const bancadas = () => contar('SELECT COUNT(*) AS n FROM core_workshops');
const bancadasDa = (companyId: string) =>
  contar('SELECT COUNT(*) AS n FROM core_workshops WHERE company_id = ?', companyId);
const tagsDa = (companyId: string) =>
  contar('SELECT COUNT(*) AS n FROM core_equipment_tags WHERE company_id = ?', companyId);

function trilha(companyId: string, action: string): { entity_id: string; detail: string }[] {
  return db()
    .prepare('SELECT entity_id, detail FROM core_audit_log WHERE company_id = ? AND action = ? ORDER BY created_at')
    .all(companyId, action) as never;
}

/** Uma máquina da Oficina (a bancada de mobilidade monta), com número sorteado. */
function maquinaDaOficina(modelo: string): { id: string; public_id: number; public_token: string } {
  const criada = createEquipment({
    companyId: oficina.id,
    workshopId: mobilidade,
    userId: oficina.userId,
    origin: 'INTERNAL_PJ_MOTORS',
    brand: 'Shineray',
    model: modelo,
  });
  return { id: criada.id, public_id: criada.public_id, public_token: criada.public_token };
}

const qr = (token: string) => request(app).get(`/api/v1/loja/equipamento/${token}`);
const colar = (a: Auth, unitId: string, tagId?: string) =>
  request(app).post(`/api/v1/core/units/${unitId}/tag`).set(a).send(tagId === undefined ? {} : { tagId });
const soltar = (a: Auth, unitId: string) => request(app).delete(`/api/v1/core/units/${unitId}/tag`).set(a);
const trocar = (a: Auth, unitId: string, novaTagId: string, motivo: string) =>
  request(app).post(`/api/v1/core/units/${unitId}/tag/replace`).set(a).send({ novaTagId, motivo });

beforeEach(async () => {
  resetDbForTests();
  produtos.clear();
  // Uma app por caso: o limitador de 300/min é por instância, e o arquivo
  // inteiro passaria dele.
  app = createApp();
  pj = await entrar('admin-pj', 'pj-motors', 'gerente_loja');
  pdvPj = await entrar('pdv-pj', 'pj-motors', 'operador_caixa_loja');
  precoJusto = await entrar('admin-pjusto', 'preco-justo', 'gerente_loja');
  oficina = await entrar('admin-oficina', 'oficina', 'gerente_oficina');
  gringa = await entrar('admin-gringa', 'gringa', 'gerente_loja');
  // A bancada de mobilidade na Oficina, a de celulares na Preço Justo. A PJ
  // Motors não ganha nenhuma — e continua sem nenhuma no fim de cada caso.
  ensureOfficialWorkshops();
  ensureOfficialTagCompanies();
  mobilidade = (
    db().prepare("SELECT id FROM core_workshops WHERE slug = 'oficina-mobilidade'").get() as { id: string }
  ).id;
});

describe('o QR antes de colar', () => {
  it('antes de colar, o QR da plaquinha liberada é 404 igual ao de um token inventado', async () => {
    const inventado = await qr('token-que-nao-existe');
    expect(inventado.status).toBe(404);
    expect(inventado.body.error.code).toBe('LOJA_EQUIPAMENTO_NAO_ENCONTRADO');

    const nomeDaPj = (db().prepare('SELECT trade_name FROM core_companies WHERE id = ?').get(pj.id) as {
      trade_name: string;
    }).trade_name;
    motoEmEstoque(pj.id);

    // Ainda GERADA: o papel não existe.
    const lote = await request(app).post('/api/v1/core/equipment-tags/batches').set(pj.auth).send({ quantidade: 1 });
    expect(lote.status).toBe(201);
    const gerada = db()
      .prepare('SELECT id, public_token FROM core_equipment_tags WHERE batch_id = ?')
      .get(String(lote.body.batchId)) as { id: string; public_token: string };
    // E LIBERADA: o adesivo existe, mas não está em moto nenhuma.
    const [livre] = await loteLiberado(1);
    expect(estado(livre!.id).status).toBe('disponivel');

    for (const token of [gerada.public_token, livre!.public_token]) {
      const res = await qr(token);
      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe(inventado.body.error.code);
      expect(res.body.error.message).toBe(inventado.body.error.message);
      const corpo = JSON.stringify(res.body);
      for (const segredo of ['#', 'Honda', nomeDaPj]) expect(corpo).not.toContain(segredo);
    }
  });
});

describe('a PJ Motors cola a plaquinha do lote na moto do estoque', () => {
  it('a PJ cola a plaquinha liberada na moto do estoque e o mesmo QR abre a moto, sem sessão', async () => {
    const [tag] = await loteLiberado(1);
    const moto = motoEmEstoque(pj.id);
    const antes = { maquinas: maquinas(), bancadas: bancadas() };

    const cola = await colar(pj.auth, moto.unitId, tag!.id);
    expect(cola.status, JSON.stringify(cola.body)).toBe(201);
    expect(cola.body.plaquinha).toMatchObject({
      tagId: tag!.id,
      publicId: tag!.public_id,
      publicIdLabel: `#${String(tag!.public_id).padStart(4, '0')}`,
    });
    expect(estado(tag!.id)).toMatchObject({ status: 'associada', unit_id: moto.unitId, equipment_id: null });

    // Sem máquina falsa e sem bancada falsa: nada nasce para a PJ.
    expect(maquinas()).toBe(antes.maquinas);
    expect(bancadas()).toBe(antes.bancadas);
    expect(bancadasDa(pj.id)).toBe(0);

    // O MESMO QR que já estava impresso abre a moto — sem sessão nenhuma.
    const pagina = await qr(tag!.public_token);
    expect(pagina.status, JSON.stringify(pagina.body)).toBe(200);
    expect(pagina.body).toMatchObject({
      publicIdLabel: cola.body.plaquinha.publicIdLabel,
      brand: 'Honda',
      model: 'CG 160',
      workshopName: null,
      inService: false,
      timeline: [],
      status: 'Disponível na loja',
      origem: 'unidade',
    });
    const corpo = JSON.stringify(pagina.body);
    for (const segredo of [moto.unitId, tag!.id, moto.productId, moto.chassi, tag!.public_token, 'cents', 'price', 'cost']) {
      expect(corpo, `a página pública vazou ${segredo}`).not.toContain(segredo);
    }

    expect(trilha(pj.id, 'unit.tag.link').map((l) => l.entity_id)).toEqual([moto.unitId]);
  });

  it('a lista de unidades, o pool e o resumo sabem do adesivo', async () => {
    const [a, b] = await loteLiberado(2);
    const moto = motoEmEstoque(pj.id);
    motoEmEstoque(pj.id);
    const resumo = async () => (await request(app).get('/api/v1/core/units/summary').set(pj.auth)).body as {
      semPlaquinha: number;
      vendidasSemPlaquinha: number;
    };
    const antes = await resumo();
    expect(antes.semPlaquinha).toBe(2);

    expect((await colar(pj.auth, moto.unitId, a!.id)).status).toBe(201);

    const lista = await request(app).get(`/api/v1/core/units/${moto.productId}`).set(pj.auth);
    expect(lista.status).toBe(200);
    const item = (lista.body.items as { id: string; plaquinhaDoPool: { publicIdLabel: string } | null }[]).find(
      (u) => u.id === moto.unitId,
    );
    expect(item?.plaquinhaDoPool?.publicIdLabel).toBe(`#${String(a!.public_id).padStart(4, '0')}`);
    // A busca por identidade (o chassi bipado no pátio) também traz o adesivo.
    const bipada = await request(app).get(`/api/v1/core/units?q=${moto.chassi}`).set(pj.auth);
    expect(bipada.status).toBe(200);
    expect(bipada.body.items).toEqual([
      expect.objectContaining({ id: moto.unitId, plaquinhaDoPool: expect.objectContaining({ tagId: a!.id }) }),
    ]);

    const pool = await request(app).get('/api/v1/core/equipment-tags?status=associada').set(pj.auth);
    expect(pool.status).toBe(200);
    const naLista = (pool.body.items as { id: string; unit_label: string | null; public_token?: string }[]).find(
      (t) => t.id === a!.id,
    );
    expect(naLista?.unit_label).toContain('CG 160');
    expect(naLista?.unit_label).toContain(moto.chassi);
    expect(naLista?.public_token).toBeUndefined();
    // A busca por texto acha a moto do estoque — e o total bate com a lista.
    const busca = await request(app).get('/api/v1/core/equipment-tags?busca=CG%20160').set(pj.auth);
    expect((busca.body.items as { id: string }[]).map((t) => t.id)).toEqual([a!.id]);
    expect(busca.body.total).toBe(1);

    // A moto com o adesivo da PJ sai da fila "sem plaquinha" — exatamente uma.
    expect((await resumo()).semPlaquinha).toBe(antes.semPlaquinha - 1);

    // Vendida com o adesivo, ela não entra na fila das vendidas sem plaquinha;
    // a vendida sem adesivo entra.
    const outra = motoEmEstoque(pj.id);
    expect((await colar(pj.auth, outra.unitId, b!.id)).status).toBe(201);
    venderSemCliente(pj.id, pj.userId, outra.productId, outra.unitId);
    const semNada = motoEmEstoque(pj.id);
    venderSemCliente(pj.id, pj.userId, semNada.productId, semNada.unitId);
    expect((await resumo()).vendidasSemPlaquinha).toBe(1);
  });

  it('as recusas do colar, uma por uma, sem gravar nada', async () => {
    const [a, b] = await loteLiberado(2);
    const m1 = motoEmEstoque(pj.id);
    const m2 = motoEmEstoque(pj.id);
    expect((await colar(pj.auth, m1.unitId, a!.id)).status).toBe(201);
    const fotoDeB = () => ({ tag: estado(b!.id), m2: unidade(m2.unitId) });
    const antes = fotoDeB();

    const recusa = async (res: request.Response, status: number, code: string) => {
      expect(res.status, JSON.stringify(res.body)).toBe(status);
      expect(res.body.error?.code).toBe(code);
      expect(fotoDeB()).toEqual(antes);
      return res;
    };

    const gerada = plaquinhaNoPool(pj.id, 8001, 'gerada');
    await recusa(await colar(pj.auth, m2.unitId, gerada.id), 409, 'CORE_TAG_NOT_RELEASED');
    expect(estado(gerada.id)).toMatchObject({ status: 'gerada', unit_id: null });

    const danificada = plaquinhaNoPool(pj.id, 8002, 'danificada');
    await recusa(await colar(pj.auth, m2.unitId, danificada.id), 409, 'CORE_TAG_DAMAGED');

    // A plaquinha que já está noutra moto.
    await recusa(await colar(pj.auth, m2.unitId, a!.id), 409, 'CORE_TAG_IN_USE');
    expect(estado(a!.id).unit_id).toBe(m1.unitId);

    // A moto que já tem adesivo da PJ não ganha um segundo.
    await recusa(await colar(pj.auth, m1.unitId, b!.id), 409, 'CORE_UNIT_ALREADY_TAGGED');

    // A moto com a plaquinha da MÁQUINA da Oficina: uma ou outra.
    const maquina = maquinaDaOficina('Jet 50');
    const m3 = motoEmEstoque(pj.id);
    vincularUnidade({ companyId: pj.id, unitId: m3.unitId, equipmentId: maquina.id, userId: pj.userId });
    const ligada = await recusa(await colar(pj.auth, m3.unitId, b!.id), 409, 'CORE_UNIT_ALREADY_LINKED');
    expect(ligada.body.error.message).toContain(`#${String(maquina.public_id).padStart(4, '0')}`);

    // E o contrário: a plaquinha de máquina não entra por cima do adesivo da PJ.
    const outraMaquina = maquinaDaOficina('Phoenix');
    await recusa(
      await request(app).post(`/api/v1/core/units/${m1.unitId}/equipment`).set(pj.auth).send({ equipmentId: outraMaquina.id }),
      409,
      'CORE_UNIT_ALREADY_TAGGED',
    );
    expect(unidade(m1.unitId).equipment_id).toBeNull();

    // Vendida e baixada: o adesivo da PJ é colado com a moto no pátio.
    const vendida = motoEmEstoque(pj.id);
    venderSemCliente(pj.id, pj.userId, vendida.productId, vendida.unitId);
    await recusa(await colar(pj.auth, vendida.unitId, b!.id), 409, 'CORE_UNIT_NOT_AVAILABLE');
    const baixada = motoEmEstoque(pj.id);
    const baixa = await request(app).post(`/api/v1/core/units/${baixada.unitId}/write-off`).set(pj.auth).send({ reason: 'quebra' });
    expect(baixa.status, JSON.stringify(baixa.body)).toBe(200);
    await recusa(await colar(pj.auth, baixada.unitId, b!.id), 409, 'CORE_UNIT_NOT_AVAILABLE');

    // Unidade de OUTRA empresa pela sessão da PJ: não encontrada.
    const daPrecoJusto = motoEmEstoque(precoJusto.id);
    await recusa(await colar(pj.auth, daPrecoJusto.unitId, b!.id), 404, 'CORE_UNIT_NOT_FOUND');
    // Plaquinha de OUTRA empresa: não encontrada, sem dizer que existe.
    const alheia = plaquinhaNoPool(precoJusto.id, 8101, 'disponivel');
    await recusa(await colar(pj.auth, m2.unitId, alheia.id), 404, 'CORE_TAG_NOT_FOUND');
    expect(estado(alheia.id)).toMatchObject({ status: 'disponivel', unit_id: null });

    await recusa(await colar(pj.auth, m2.unitId), 400, 'CORE_TAG_REQUIRED');
  });
});

describe('reimprimir, soltar e trocar pela unidade', () => {
  it('reimprime pela unidade: mesmo número, mesmo QR', async () => {
    const [tag] = await loteLiberado(1);
    const moto = motoEmEstoque(pj.id);
    expect((await colar(pj.auth, moto.unitId, tag!.id)).status).toBe(201);
    const eventos = contar('SELECT COUNT(*) AS n FROM core_equipment_events');

    const folha = await request(app).post(`/api/v1/core/units/${moto.unitId}/equipment/sheet`).set(pj.auth).send({});
    expect(folha.status, JSON.stringify(folha.body)).toBe(200);
    expect(folha.body).toMatchObject({ publicIdLabel: `#${String(tag!.public_id).padStart(4, '0')}`, plaquinhas: 1 });
    // O QR desenhado é o do endereço do token que já está colado — o mesmo
    // desenho que a folha do lote fez. A folha traz o SVG, não o texto.
    const esperado = desenharQr(`${publicBaseUrl()}/equipamento/${tag!.public_token}`, {
      nivel: equipmentTagFormat(undefined).nivelQr,
    }).svg.match(/ d="([^"]+)"/)![1]!;
    expect(String(folha.body.html)).toContain(esperado);
    expect(estado(tag!.id)).toMatchObject({ status: 'associada', unit_id: moto.unitId });

    const [linha] = trilha(pj.id, 'unit.equipment.label.reprint');
    expect(JSON.parse(linha!.detail)).toMatchObject({ tagId: tag!.id, equipmentId: null });
    // Não há máquina: nenhum evento de máquina é gravado.
    expect(contar('SELECT COUNT(*) AS n FROM core_equipment_events')).toBe(eventos);
  });

  it('solta e a plaquinha volta livre — o QR volta ao 404', async () => {
    const [tag] = await loteLiberado(1);
    const moto = motoEmEstoque(pj.id);
    expect((await colar(pj.auth, moto.unitId, tag!.id)).status).toBe(201);
    expect((await qr(tag!.public_token)).status).toBe(200);

    const solta = await soltar(pj.auth, moto.unitId);
    expect(solta.status, JSON.stringify(solta.body)).toBe(204);
    expect(estado(tag!.id)).toMatchObject({ status: 'disponivel', unit_id: null, associated_at: null });
    expect((await qr(tag!.public_token)).status).toBe(404);
    const [linha] = trilha(pj.id, 'unit.tag.unlink');
    expect(JSON.parse(linha!.detail)).toMatchObject({
      tagId: tag!.id,
      publicId: `#${String(tag!.public_id).padStart(4, '0')}`,
    });

    // O adesivo físico continua existindo: cola de novo, e o QR volta.
    expect((await colar(pj.auth, moto.unitId, tag!.id)).status).toBe(201);
    expect((await qr(tag!.public_token)).status).toBe(200);

    // Soltar de moto sem adesivo é recusa, não silêncio.
    const semAdesivo = motoEmEstoque(pj.id);
    const nada = await soltar(pj.auth, semAdesivo.unitId);
    expect(nada.status).toBe(409);
    expect(nada.body.error.code).toBe('CORE_UNIT_WITHOUT_TAG');
  });

  it('troca o adesivo estragado: o QR velho morre na hora, o novo abre a moto', async () => {
    const [velha, nova, reserva] = await loteLiberado(3);
    const moto = motoEmEstoque(pj.id);
    expect((await colar(pj.auth, moto.unitId, velha!.id)).status).toBe(201);

    // Sem motivo: recusa antes de qualquer escrita.
    const semMotivo = await trocar(pj.auth, moto.unitId, nova!.id, '   ');
    expect(semMotivo.status).toBe(400);
    expect(semMotivo.body.error.code).toBe('CORE_TAG_REPLACE_REASON');
    expect(estado(velha!.id)).toMatchObject({ status: 'associada', unit_id: moto.unitId });
    expect(estado(nova!.id)).toMatchObject({ status: 'disponivel', unit_id: null });

    // A plaquinha nova ainda gerada não entra.
    const gerada = plaquinhaNoPool(pj.id, 8201, 'gerada');
    const naoLiberada = await trocar(pj.auth, moto.unitId, gerada.id, 'descascou');
    expect(naoLiberada.status).toBe(409);
    expect(naoLiberada.body.error.code).toBe('CORE_TAG_NOT_AVAILABLE');
    expect(estado(velha!.id).status).toBe('associada');

    const troca = await trocar(pj.auth, moto.unitId, nova!.id, 'descascou no sol');
    expect(troca.status, JSON.stringify(troca.body)).toBe(200);
    expect(troca.body).toEqual({
      anterior: `#${String(velha!.public_id).padStart(4, '0')}`,
      atual: `#${String(nova!.public_id).padStart(4, '0')}`,
    });
    // A velha morre GUARDANDO de qual moto era.
    expect(estado(velha!.id)).toMatchObject({ status: 'danificada', damaged_reason: 'descascou no sol', unit_id: moto.unitId });
    expect(estado(nova!.id)).toMatchObject({ status: 'associada', unit_id: moto.unitId });
    expect((await qr(velha!.public_token)).status).toBe(404);
    expect((await qr(nova!.public_token)).status).toBe(200);
    expect(trilha(pj.id, 'unit.tag.replace')).toHaveLength(1);

    // A moto com a plaquinha da MÁQUINA não troca por aqui: a máquina é da Oficina.
    const maquina = maquinaDaOficina('Jet 50');
    const comMaquina = motoEmEstoque(pj.id);
    vincularUnidade({ companyId: pj.id, unitId: comMaquina.unitId, equipmentId: maquina.id, userId: pj.userId });
    const daMaquina = await trocar(pj.auth, comMaquina.unitId, reserva!.id, 'descascou');
    expect(daMaquina.status).toBe(409);
    expect(daMaquina.body.error.code).toBe('CORE_UNIT_MACHINE_TAG');
    expect(
      db().prepare('SELECT public_id, public_token FROM core_equipment WHERE id = ?').get(maquina.id),
    ).toEqual({ public_id: maquina.public_id, public_token: maquina.public_token });
    expect(estado(reserva!.id).status).toBe('disponivel');
  });

  /*
    AS DUAS ESCRITAS DA TROCA SÃO GUARDADAS (resíduo do P0).

    A nova entrava com `WHERE id = ? AND status = 'disponivel'` (sem conferir
    que estava sem moto e sem máquina) e a velha morria com `WHERE id = ?` (sem
    conferir que ainda era desta moto). O id vazio caía em "não encontrada".
  */
  it('a troca confere o adesivo novo e o velho na própria escrita — nunca meia troca', async () => {
    const [velha, nova] = await loteLiberado(2);
    const moto = motoEmEstoque(pj.id);
    expect((await colar(pj.auth, moto.unitId, velha!.id)).status).toBe(201);
    const foto = () => ({ velha: estado(velha!.id), nova: estado(nova!.id), moto: unidade(moto.unitId) });
    const antes = foto();

    // Sem o adesivo novo: pedido incompleto (400), e não "plaquinha não encontrada".
    const semAdesivo = await trocar(pj.auth, moto.unitId, '', 'descascou');
    expect(semAdesivo.status, JSON.stringify(semAdesivo.body)).toBe(400);
    expect(semAdesivo.body.error.code).toBe('CORE_TAG_REQUIRED');
    expect(foto()).toEqual(antes);

    // A "disponível" que ainda aponta para OUTRA moto (banco antigo): não é arrancada de lá.
    const outraMoto = motoEmEstoque(pj.id);
    const presaNaMoto = plaquinhaNoPool(pj.id, 8501, 'disponivel');
    db().prepare('UPDATE core_equipment_tags SET unit_id = ? WHERE id = ?').run(outraMoto.unitId, presaNaMoto.id);
    const naOutraMoto = await trocar(pj.auth, moto.unitId, presaNaMoto.id, 'descascou');
    expect(naOutraMoto.status, JSON.stringify(naOutraMoto.body)).toBe(409);
    expect(naOutraMoto.body.error.code).toBe('CORE_TAG_NOT_AVAILABLE');
    expect(estado(presaNaMoto.id)).toMatchObject({ status: 'disponivel', unit_id: outraMoto.unitId });
    expect(foto()).toEqual(antes);

    // A "disponível" que ainda aponta para uma MÁQUINA: também não.
    const maquina = maquinaDaOficina('Jet 50');
    const presaNaMaquina = plaquinhaNoPool(pj.id, 8502, 'disponivel');
    db().prepare('UPDATE core_equipment_tags SET equipment_id = ? WHERE id = ?').run(maquina.id, presaNaMaquina.id);
    const naMaquina = await trocar(pj.auth, moto.unitId, presaNaMaquina.id, 'descascou');
    expect(naMaquina.status, JSON.stringify(naMaquina.body)).toBe(409);
    expect(naMaquina.body.error.code).toBe('CORE_TAG_NOT_AVAILABLE');
    expect(estado(presaNaMaquina.id)).toMatchObject({ status: 'disponivel', unit_id: null, equipment_id: maquina.id });
    expect(foto()).toEqual(antes);

    /*
      A velha deixa a moto NO MEIO da escrita. Um gatilho temporário faz o que
      uma escrita concorrente faria: assim que a nova entra, solta a velha. A
      guarda da velha não acha a linha, e a transação desfaz tudo — a nova, a
      velha e o próprio gatilho.
    */
    db().exec(
      `CREATE TEMP TRIGGER solta_a_velha_no_meio AFTER UPDATE OF status ON core_equipment_tags
         WHEN NEW.id = '${nova!.id}' AND NEW.status = 'associada'
       BEGIN
         UPDATE core_equipment_tags SET status = 'disponivel', unit_id = NULL, associated_at = NULL
          WHERE id = '${velha!.id}';
       END`,
    );
    try {
      const corrida = await trocar(pj.auth, moto.unitId, nova!.id, 'descascou');
      expect(corrida.status, JSON.stringify(corrida.body)).toBe(409);
      expect(corrida.body.error.code).toBe('CORE_UNIT_TAG_CHANGED');
    } finally {
      db().exec('DROP TRIGGER IF EXISTS temp.solta_a_velha_no_meio');
    }
    expect(foto()).toEqual(antes);
    expect(trilha(pj.id, 'unit.tag.replace')).toHaveLength(0);

    // Sem a corrida, a mesma troca passa.
    const troca = await trocar(pj.auth, moto.unitId, nova!.id, 'descascou');
    expect(troca.status, JSON.stringify(troca.body)).toBe(200);
    expect(estado(velha!.id)).toMatchObject({ status: 'danificada', unit_id: moto.unitId });
    expect(estado(nova!.id)).toMatchObject({ status: 'associada', unit_id: moto.unitId });
  });
});

describe('a venda e a baixa', () => {
  it('a venda da moto com plaquinha da PJ segue como qualquer venda', async () => {
    /*
      NENHUM CÓDIGO NOVO NESTE CAMINHO — é o pino de regressão. A unidade só
      com o adesivo da PJ não tem máquina onde carimbar dono, então vende SEM
      cliente como qualquer unidade serializada; a moto com a plaquinha da
      MÁQUINA continua exigindo o comprador.
    */
    const [tag, nova] = await loteLiberado(2);
    const moto = motoEmEstoque(pj.id);
    expect((await colar(pj.auth, moto.unitId, tag!.id)).status).toBe(201);

    const { sale } = venderSemCliente(pj.id, pj.userId, moto.productId, moto.unitId);
    expect(unidade(moto.unitId).status).toBe('sold');
    // O adesivo acompanha a moto: a página continua, sem "à venda".
    expect(estado(tag!.id)).toMatchObject({ status: 'associada', unit_id: moto.unitId });
    const vendida = await qr(tag!.public_token);
    expect(vendida.status).toBe(200);
    expect(vendida.body.status).toBeNull();

    const solta = await soltar(pj.auth, moto.unitId);
    expect(solta.status).toBe(409);
    expect(solta.body.error.code).toBe('CORE_UNIT_NOT_AVAILABLE');
    // O adesivo estragado na garagem do comprador ainda se troca.
    const troca = await trocar(pj.auth, moto.unitId, nova!.id, 'descascou no sol');
    expect(troca.status, JSON.stringify(troca.body)).toBe(200);

    // A regra velha segue viva: moto com plaquinha de MÁQUINA sem cliente é recusada.
    const maquina = maquinaDaOficina('Jet 50');
    const comMaquina = motoEmEstoque(pj.id);
    vincularUnidade({ companyId: pj.id, unitId: comMaquina.unitId, equipmentId: maquina.id, userId: pj.userId });
    expect(() => venderSemCliente(pj.id, pj.userId, comMaquina.productId, comMaquina.unitId)).toThrow(
      expect.objectContaining({ code: 'CORE_SALE_EQUIPMENT_WITHOUT_CUSTOMER' }),
    );
    expect(unidade(comMaquina.unitId).status).toBe('in_stock');

    // A venda desfeita devolve a moto ao pátio — e a página volta a dizer isso.
    cancelSale({ companyId: pj.id, saleId: sale.id, userId: pj.userId, reason: 'desistência' });
    expect(unidade(moto.unitId).status).toBe('in_stock');
    const devolvida = await qr(nova!.public_token);
    expect(devolvida.status).toBe(200);
    expect(devolvida.body.status).toBe('Disponível na loja');
  });

  it('a baixa não solta nem apaga: o QR da moto baixada some', async () => {
    const [tag, nova] = await loteLiberado(2);
    const moto = motoEmEstoque(pj.id);
    expect((await colar(pj.auth, moto.unitId, tag!.id)).status).toBe(201);

    const baixa = await request(app).post(`/api/v1/core/units/${moto.unitId}/write-off`).set(pj.auth).send({ reason: 'batida' });
    expect(baixa.status, JSON.stringify(baixa.body)).toBe(200);
    expect(unidade(moto.unitId).status).toBe('baixada');
    expect(estado(tag!.id)).toMatchObject({ status: 'associada', unit_id: moto.unitId });
    expect((await qr(tag!.public_token)).status).toBe(404);

    const solta = await soltar(pj.auth, moto.unitId);
    expect(solta.status).toBe(409);
    expect(solta.body.error.code).toBe('CORE_UNIT_NOT_AVAILABLE');
    const troca = await trocar(pj.auth, moto.unitId, nova!.id, 'x');
    expect(troca.status).toBe(409);
    expect(troca.body.error.code).toBe('CORE_UNIT_NOT_AVAILABLE');
    expect(estado(nova!.id).status).toBe('disponivel');
  });
});

/*
  A VENDA E A VOLTA PELAS ROTAS DE VERDADE (resíduo do P0).

  O pino de regressão acima chama os serviços. Este vai pelo balcão: caixa
  aberto, POST /core/sales, a devolução por POST /core/sale-returns e o
  cancelamento por POST /core/sales/:id/cancel — com uma moto com o adesivo da
  PJ e outra com a plaquinha da MÁQUINA na mesma venda.
*/
describe('a venda e a volta pelas rotas de verdade', () => {
  it('o QR da moto com o adesivo vai a vendida e volta — pela devolução e pelo cancelamento — e a moto da máquina segue igual', async () => {
    const [tag] = await loteLiberado(1);
    const comAdesivo = motoEmEstoque(pj.id);
    expect((await colar(pj.auth, comAdesivo.unitId, tag!.id)).status).toBe(201);
    const maquina = maquinaDaOficina('Jet 50');
    const comMaquina = motoEmEstoque(pj.id);
    vincularUnidade({ companyId: pj.id, unitId: comMaquina.unitId, equipmentId: maquina.id, userId: pj.userId });
    const situacaoDoQr = async (token: string) => {
      const res = await qr(token);
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      return res.body.status as string | null;
    };
    const daMaquina = () =>
      db().prepare('SELECT sale_status, owner_customer_id FROM core_equipment WHERE id = ?').get(maquina.id) as {
        sale_status: string;
        owner_customer_id: string | null;
      };
    expect(await situacaoDoQr(tag!.public_token)).toBe('Disponível na loja');

    const caixa = await request(app).post('/api/v1/core/cash/open').set(pj.auth).send({ openingCents: 0 });
    expect(caixa.status, JSON.stringify(caixa.body)).toBe(201);
    const cliente = await request(app)
      .post('/api/v1/core/customers')
      .set(pj.auth)
      .send({ name: 'Rafaela Compradora', document: '52998224725' });
    expect(cliente.status, JSON.stringify(cliente.body)).toBe(201);

    // 1. As duas motos na MESMA venda do balcão, com o cliente que a plaquinha da máquina exige.
    const venda = await request(app)
      .post('/api/v1/core/sales')
      .set(pj.auth)
      .set('Idempotency-Key', randomUUID())
      .send({
        customerId: cliente.body.id,
        items: [{ productId: comAdesivo.productId, quantity: 2, unitIds: [comAdesivo.unitId, comMaquina.unitId] }],
        payments: [{ method: 'dinheiro', amountCents: 2 * PRECO }],
        cashSessionId: caixa.body.id,
      });
    expect(venda.status, JSON.stringify(venda.body)).toBe(201);
    expect(unidade(comAdesivo.unitId).status).toBe('sold');
    expect(unidade(comMaquina.unitId).status).toBe('sold');
    expect(await situacaoDoQr(tag!.public_token)).toBeNull();
    expect(estado(tag!.id)).toMatchObject({ status: 'associada', unit_id: comAdesivo.unitId });
    expect(daMaquina().sale_status).toBe('SOLD');
    expect(daMaquina().owner_customer_id).not.toBeNull();

    // 2. Volta SÓ a moto do adesivo, pela devolução do balcão.
    const devolviveis = await request(app).get(`/api/v1/core/sales/${venda.body.id}/returnable`).set(pj.auth);
    expect(devolviveis.status).toBe(200);
    const linha = (devolviveis.body.items as { product_id: string; sale_item_id: string }[]).find(
      (i) => i.product_id === comAdesivo.productId,
    )!;
    const devolucao = await request(app)
      .post('/api/v1/core/sale-returns')
      .set(pj.auth)
      .send({
        saleId: venda.body.id,
        reason: 'Arrependimento no prazo',
        items: [{ saleItemId: linha.sale_item_id, quantity: 1, unitIds: [comAdesivo.unitId] }],
      });
    expect(devolucao.status, JSON.stringify(devolucao.body)).toBe(201);
    expect(unidade(comAdesivo.unitId).status).toBe('in_stock');
    expect(await situacaoDoQr(tag!.public_token)).toBe('Disponível na loja');
    expect(estado(tag!.id)).toMatchObject({ status: 'associada', unit_id: comAdesivo.unitId });
    // A moto da máquina ficou com o cliente: vendida, com dono, e o QR dela abre.
    expect(unidade(comMaquina.unitId).status).toBe('sold');
    expect(daMaquina().sale_status).toBe('SOLD');
    expect((await qr(maquina.public_token)).status).toBe(200);

    // 3. A moto do adesivo vende de novo, SEM cliente, e a venda é cancelada pela rota.
    const segunda = await request(app)
      .post('/api/v1/core/sales')
      .set(pj.auth)
      .set('Idempotency-Key', randomUUID())
      .send({
        items: [{ productId: comAdesivo.productId, quantity: 1, unitIds: [comAdesivo.unitId] }],
        payments: [{ method: 'dinheiro', amountCents: PRECO }],
        cashSessionId: caixa.body.id,
      });
    expect(segunda.status, JSON.stringify(segunda.body)).toBe(201);
    expect(await situacaoDoQr(tag!.public_token)).toBeNull();
    const cancelada = await request(app)
      .post(`/api/v1/core/sales/${segunda.body.id}/cancel`)
      .set(pj.auth)
      .send({ reason: 'Desistência do cliente' });
    expect(cancelada.status, JSON.stringify(cancelada.body)).toBe(200);
    expect(unidade(comAdesivo.unitId).status).toBe('in_stock');
    expect(await situacaoDoQr(tag!.public_token)).toBe('Disponível na loja');
    expect(estado(tag!.id)).toMatchObject({ status: 'associada', unit_id: comAdesivo.unitId });

    // 4. A moto da máquina volta pela devolução: o cliente deixa de ser o dono, como sempre foi.
    const devolveMaquina = await request(app)
      .post('/api/v1/core/sale-returns')
      .set(pj.auth)
      .send({
        saleId: venda.body.id,
        reason: 'Arrependimento no prazo',
        items: [{ saleItemId: linha.sale_item_id, quantity: 1, unitIds: [comMaquina.unitId] }],
      });
    expect(devolveMaquina.status, JSON.stringify(devolveMaquina.body)).toBe(201);
    expect(unidade(comMaquina.unitId).status).toBe('in_stock');
    expect(daMaquina()).toEqual({ sale_status: 'NOT_SOLD', owner_customer_id: null });
  });
});

/*
  O MODELO "ESTOQUE" SEM BECO (resíduo do P0).

  Ele tem `inventory.units.manage` — o servidor aceita dele colar e trocar — e
  não tem `workshop.tags.view`, a leitura do pool, de onde a tela tirava a lista
  de adesivos livres: 403, e a tela dizia "nenhuma plaquinha livre". A leitura
  estreita da unidade vive sob a mesma capability de colar.
*/
describe('o modelo Estoque cola e troca sem cair num beco', () => {
  it('a lista estreita mostra só o que o colar aceita, sem token — e o pool continua fechado a ele', async () => {
    const estoque = await entrar('estoque-pj', 'pj-motors', 'estoque');
    const [a, b, c] = await loteLiberado(3);
    const moto = motoEmEstoque(pj.id);
    const rotulo = (n: number) => `#${String(n).padStart(4, '0')}`;
    // O que o colar recusa não aparece: gerada, danificada, associada, a "disponível"
    // presa a outra moto (banco antigo) e a de outra empresa.
    const gerada = plaquinhaNoPool(pj.id, 8401, 'gerada');
    const danificada = plaquinhaNoPool(pj.id, 8402, 'danificada');
    const presa = plaquinhaNoPool(pj.id, 8403, 'disponivel');
    db().prepare('UPDATE core_equipment_tags SET unit_id = ? WHERE id = ?').run(motoEmEstoque(pj.id).unitId, presa.id);
    const alheia = plaquinhaNoPool(precoJusto.id, 8404, 'disponivel');
    const livres = (auth: Auth, busca?: string) =>
      request(app).get(`/api/v1/core/units/${moto.unitId}/tag/livres${busca === undefined ? '' : `?busca=${encodeURIComponent(busca)}`}`).set(auth);

    const lista = await livres(estoque.auth);
    expect(lista.status, JSON.stringify(lista.body)).toBe(200);
    expect(lista.body.items).toEqual(
      [a!, b!, c!].map((t) => ({ id: t.id, public_id: t.public_id, publicIdLabel: rotulo(t.public_id) })),
    );
    for (const t of [a!, b!, c!, gerada, danificada, presa, alheia]) expect(lista.text).not.toContain(t.public_token);

    // A busca pelo número, do jeito que o balcão fala; texto não acha nada.
    expect(((await livres(estoque.auth, rotulo(b!.public_id))).body.items as { id: string }[]).map((t) => t.id)).toEqual([b!.id]);
    expect(((await livres(estoque.auth, String(b!.public_id))).body.items as { id: string }[]).map((t) => t.id)).toEqual([b!.id]);
    expect((await livres(estoque.auth, 'CG 160')).body.items).toEqual([]);

    // Unidade de outra empresa pela sessão da PJ: não encontrada.
    const daPrecoJusto = motoEmEstoque(precoJusto.id);
    const alheiaUnidade = await request(app).get(`/api/v1/core/units/${daPrecoJusto.unitId}/tag/livres`).set(estoque.auth);
    expect(alheiaUnidade.status).toBe(404);
    expect(alheiaUnidade.body.error.code).toBe('CORE_UNIT_NOT_FOUND');

    // O pool inteiro continua sendo workshop.tags.view: o modelo Estoque não o lê.
    const pool = await request(app).get('/api/v1/core/equipment-tags?status=disponivel').set(estoque.auth);
    expect(pool.status).toBe(403);
    expect(pool.body.error.code).toBe('API_PERMISSION_DENIED');

    // Cola e troca pelas rotas de sempre, com o que a lista mostrou.
    expect((await colar(estoque.auth, moto.unitId, a!.id)).status).toBe(201);
    expect(((await livres(estoque.auth)).body.items as { id: string }[]).map((t) => t.id)).toEqual([b!.id, c!.id]);
    const troca = await trocar(estoque.auth, moto.unitId, b!.id, 'descascou no sol');
    expect(troca.status, JSON.stringify(troca.body)).toBe(200);
    expect(estado(a!.id)).toMatchObject({ status: 'danificada', unit_id: moto.unitId });
    expect(estado(b!.id)).toMatchObject({ status: 'associada', unit_id: moto.unitId });
  });
});

describe('só a PJ Motors', () => {
  it('plaquinha forçada fora da PJ não abre página', async () => {
    // O pior banco antigo: uma plaquinha da Gringa colada numa unidade da
    // Gringa, gravada à mão. A página não reabre para ela.
    const daGringa = motoEmEstoque(gringa.id);
    const tag = plaquinhaNoPool(gringa.id, 8301, 'associada');
    db().prepare('UPDATE core_equipment_tags SET unit_id = ?, associated_at = ? WHERE id = ?').run(daGringa.unitId, agora(), tag.id);
    getConnection().prepare('UPDATE core_companies SET uses_equipment_tags = 1').run();

    const res = await qr(tag.public_token);
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('LOJA_EQUIPAMENTO_NAO_ENCONTRADO');
  });

  it('o caixa do PDV da PJ não administra (PDV não administra)', async () => {
    const [tag, nova] = await loteLiberado(2);
    const livre = motoEmEstoque(pj.id);
    const colada = motoEmEstoque(pj.id);
    expect((await colar(pj.auth, colada.unitId, tag!.id)).status).toBe(201);
    const maquina = maquinaDaOficina('Jet 50');
    const antes = { livre: unidade(livre.unitId), tag: estado(tag!.id), nova: estado(nova!.id), tags: tagsDa(pj.id) };

    const gestos = [
      { nome: 'POST /units/:id/tag', chamar: () => colar(pdvPj.auth, livre.unitId, nova!.id) },
      { nome: 'DELETE /units/:id/tag', chamar: () => soltar(pdvPj.auth, colada.unitId) },
      { nome: 'POST /units/:id/tag/replace', chamar: () => trocar(pdvPj.auth, colada.unitId, nova!.id, 'x') },
      {
        nome: 'GET /units/:id/tag/livres',
        chamar: () => request(app).get(`/api/v1/core/units/${livre.unitId}/tag/livres`).set(pdvPj.auth),
      },
      {
        nome: 'POST /print/jobs EQUIPMENT_QR_TAG',
        chamar: () =>
          request(app)
            .post('/api/v1/core/print/jobs')
            .set(pdvPj.auth)
            .send({ documentType: 'EQUIPMENT_QR_TAG', documentId: maquina.id }),
      },
    ];
    for (const gesto of gestos) {
      const res = await gesto.chamar();
      expect(res.status, `${gesto.nome}: ${JSON.stringify(res.body)}`).toBe(403);
      expect(res.body.error?.code, gesto.nome).toBe('API_PERMISSION_DENIED');
    }
    expect({ livre: unidade(livre.unitId), tag: estado(tag!.id), nova: estado(nova!.id), tags: tagsDa(pj.id) }).toEqual(antes);
    expect(contar('SELECT COUNT(*) AS n FROM core_print_jobs WHERE company_id = ?', pj.id)).toBe(0);
  });
});

describe('fora da PJ Motors, 403 CORE_COMPANY_NO_TAGS — com a marca desligada e ligada', () => {
  for (const [nome, qual] of [
    ['Preço Justo', () => precoJusto],
    ['Oficina (com bancada)', () => oficina],
    ['Gringa', () => gringa],
  ] as const) {
    for (const marcaLigada of [false, true]) {
      it(`${nome}${marcaLigada ? ', com a marca ligada no banco' : ''}: as três rotas novas recusam, sem dado da PJ e sem gravar nada`, async () => {
        const quem = qual();
        if (marcaLigada) getConnection().prepare('UPDATE core_companies SET uses_equipment_tags = 1').run();
        if (quem === oficina) expect(contar('SELECT COUNT(*) AS n FROM core_workshops WHERE company_id = ? AND active = 1', oficina.id)).toBeGreaterThan(0);

        const livrePj = plaquinhaNoPool(pj.id, 7102, 'disponivel');
        const daPj = motoEmEstoque(pj.id);
        const dela = motoEmEstoque(quem.id);
        const antes = {
          pj: tagsDa(pj.id),
          dela: tagsDa(quem.id),
          maquinas: maquinas(),
          bancadas: bancadas(),
          unidade: unidade(dela.unitId),
        };

        const gestos = [
          { nome: 'POST /units/:id/tag', chamar: () => colar(quem.auth, dela.unitId, livrePj.id) },
          { nome: 'DELETE /units/:id/tag', chamar: () => soltar(quem.auth, dela.unitId) },
          { nome: 'POST /units/:id/tag/replace', chamar: () => trocar(quem.auth, dela.unitId, livrePj.id, 'x') },
          // A unidade da PJ, pela sessão dela: nem o 404 da unidade escapa.
          { nome: 'POST /units/:id/tag (unidade da PJ)', chamar: () => colar(quem.auth, daPj.unitId, livrePj.id) },
          // Corpo vazio: a regra da empresa vem antes da conferência do corpo.
          { nome: 'POST /units/:id/tag (sem corpo)', chamar: () => colar(quem.auth, dela.unitId) },
          // A lista dos livres: nem o número de um adesivo da PJ escapa.
          {
            nome: 'GET /units/:id/tag/livres',
            chamar: () => request(app).get(`/api/v1/core/units/${dela.unitId}/tag/livres`).set(quem.auth),
          },
          {
            nome: 'GET /units/:id/tag/livres (unidade da PJ)',
            chamar: () => request(app).get(`/api/v1/core/units/${daPj.unitId}/tag/livres`).set(quem.auth),
          },
        ];
        for (const gesto of gestos) {
          const res = await gesto.chamar();
          expect(res.status, `${gesto.nome}: ${JSON.stringify(res.body)}`).toBe(403);
          expect(res.body.error?.code, gesto.nome).toBe('CORE_COMPANY_NO_TAGS');
          const corpo = JSON.stringify(res.body);
          for (const segredo of ['#7102', livrePj.public_token, 'CG 160', daPj.chassi]) {
            expect(corpo, `${gesto.nome} vazou ${segredo}`).not.toContain(segredo);
          }
        }

        // Nada foi escrito: nem plaquinha, nem máquina, nem bancada, nem vínculo.
        expect(estado(livrePj.id)).toMatchObject({ status: 'disponivel', unit_id: null });
        expect({
          pj: tagsDa(pj.id),
          dela: tagsDa(quem.id),
          maquinas: maquinas(),
          bancadas: bancadas(),
          unidade: unidade(dela.unitId),
        }).toEqual(antes);
      });
    }
  }
});
