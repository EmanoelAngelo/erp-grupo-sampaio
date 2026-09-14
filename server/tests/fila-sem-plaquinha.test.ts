/**
 * A FILA DE VÍNCULO — `GET /core/units/summary`.
 *
 * ## O defeito que esta rota existe para matar
 *
 * A tela de Unidades já dizia "N sem plaquinha", mas só DEPOIS de escolher o
 * produto — e escolher o produto é justamente o passo difícil, porque exige
 * adivinhar de qual cadastro saiu a moto que se tem na mão. Enquanto o número
 * dependesse desse passo, a fila não existia: ninguém vincula o que não vê, e
 * tudo o que o vínculo entrega (o comprador virar dono, o QR responder, a
 * garantia ter a quem pertencer) ficava parado sem que ninguém tivesse recusado
 * nada.
 *
 * ## Por que os testes daqui passam pelo HTTP
 *
 * O que está sendo protegido não é uma função, é uma ROTA: o corte por empresa
 * vem do token, e a rota só é alcançável se estiver declarada ANTES de
 * `/units/:productId` — declarada depois, o Express a entrega para a outra com
 * `productId = 'summary'`, que responde 200 com lista vazia. Esse é o pior jeito
 * de quebrar, porque não parece quebrado; só um teste que fala HTTP o pega.
 *
 * ## A travessia de empresa é o assunto, e não um descuido
 *
 * A oficina é OUTRA EMPRESA: `createEquipment` exige que a oficina pertença à
 * empresa que cria a plaquinha, logo a loja não pode criar a sua. Por isso o
 * cenário tem duas empresas de verdade — vincular dentro de uma só seria
 * percorrer um caminho que a operação nunca percorre.
 *
 * ## O que cada `it` tem de conseguir derrubar
 *
 * Cada teste daqui foi verificado quebrando o guarda que ele cobre — apagando
 * um pedaço do `WHERE`, movendo a rota para depois de `/units/:productId` —
 * e conferindo que fica VERMELHO. Teste que continua verde com o guarda
 * desligado não protege nada.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { resetDbForTests } from '../src/db/database.js';
import { getConnection } from '../src/db/sqlite.js';
import { ensureCoreSchema } from '../src/db/schema.js';
import { ensureOfficialTagCompanies,
  ensureOfficialWorkshops } from '../src/db/core-migrations.js';
import {
  linkUserToCompany,
  upsertCompany,
  upsertUser,
} from '../src/services/auth/IdentityService.js';
import { createProduct, updateProduct } from '../src/services/core/CatalogService.js';
import { applyMovement } from '../src/services/core/InventoryService.js';
import { createUnits } from '../src/services/core/ProductUnitService.js';
import { createSale } from '../src/services/core/SalesService.js';
import { createEquipment } from '../src/services/core/EquipmentService.js';
import { vincularUnidade } from '../src/services/core/EquipmentStockLink.js';

const SENHA = 'Teste@Fila2026';
const app = createApp();

let loja: string;
let outraLoja: string;
let oficinaCo: string;
let mobilidade: string;
let vendedor: string;
let outroVendedor: string;
let mecanico: string;
let moto: string;
let celular: string;
let auth: { Authorization: string };

function workshopIdOf(slug: string): string {
  return (
    getConnection().prepare('SELECT id FROM core_workshops WHERE slug = ?').get(slug) as {
      id: string;
    }
  ).id;
}

async function tokenDe(login: string, companyId: string): Promise<string> {
  const res = await request(app)
    .post('/api/v1/auth/login')
    .send({ login, password: SENHA, companyId });
  expect(res.status).toBe(200);
  return res.body.accessToken as string;
}

/** Cria N unidades E o saldo correspondente, que é como a entrada de nota faz. */
function entrarComUnidades(empresa: string, produto: string, quantidade: number, ref: string): string[] {
  const ids = createUnits(empresa, produto, quantidade, {
    entryReferenceType: 'ajuste',
    entryReferenceId: ref,
  });
  applyMovement({
    companyId: empresa,
    productId: produto,
    movementType: 'in',
    quantity: quantidade,
    referenceType: 'ajuste',
    referenceId: ref,
    unitIds: ids,
  });
  return ids;
}

/** Uma plaquinha INTERNA na oficina — que é outra empresa. */
function criarPlaquinha(chassis?: string) {
  return createEquipment({
    companyId: oficinaCo,
    workshopId: mobilidade,
    userId: mecanico,
    origin: 'INTERNAL_PJ_MOTORS',
    brand: 'PJ Motors',
    model: 'Sport 3000',
    chassis,
  });
}

/** O número que a tela mostra no topo, pelo caminho que a tela usa. */
async function fila(headers: { Authorization: string } = auth): Promise<number> {
  const res = await request(app).get('/api/v1/core/units/summary').set(headers);
  expect(res.status).toBe(200);
  return res.body.semPlaquinha as number;
}

beforeEach(async () => {
  resetDbForTests();
  ensureCoreSchema();

  loja = upsertCompany({
    slug: 'pj-motors',
    legalName: 'PJ Motors Ltda',
    tradeName: 'PJ Motors',
    kind: 'store',
  });
  outraLoja = upsertCompany({
    slug: 'me-mimei',
    legalName: 'Me Mimei Ltda',
    tradeName: 'Me Mimei',
    kind: 'store',
  });
  oficinaCo = upsertCompany({
    slug: 'oficina',
    legalName: 'Oficina Ltda',
    tradeName: 'Oficina',
    kind: 'workshop',
  });
  ensureOfficialWorkshops();
  // A regra de ouro do dono (rodada 53): PJ Motors e Oficina usam
  // plaquinha. O teste monta um grupo de mentira e tem de dizer o mesmo
  // que o seed diz.
  ensureOfficialTagCompanies();
  mobilidade = workshopIdOf('oficina-mobilidade');

  vendedor = await upsertUser({ login: 'BALCAO_FILA', displayName: 'Balcão', password: SENHA });
  linkUserToCompany(vendedor, loja, 'gerente_loja', true);
  outroVendedor = await upsertUser({
    login: 'BALCAO_FILA_2',
    displayName: 'Balcão 2',
    password: SENHA,
  });
  linkUserToCompany(outroVendedor, outraLoja, 'gerente_loja', true);
  mecanico = await upsertUser({ login: 'MEC_FILA', displayName: 'Mecânico', password: SENHA });
  linkUserToCompany(mecanico, oficinaCo, 'gerente_oficina', true);

  moto = createProduct(loja, { name: 'Honda CG 160', priceCents: 1_800_000 }).id;
  updateProduct(loja, moto, { serialized: true });
  celular = createProduct(loja, { name: 'Celular X', priceCents: 200_000 }).id;
  updateProduct(loja, celular, { serialized: true });

  auth = { Authorization: `Bearer ${await tokenDe('BALCAO_FILA', loja)}` };
});

describe('a fila aparece sem escolher produto', () => {
  /**
   * O teste central da rodada: o número existe ANTES do passo difícil.
   *
   * Soma produtos DIFERENTES de propósito. Fosse por produto — que é o que a
   * tela já sabia fazer — dois cadastros dariam dois números, e nenhum deles
   * seria a fila. É esta soma que o operador não tem como fazer de cabeça.
   *
   * Derruba a rota declarada no lugar errado: depois de `/units/:productId` o
   * Express responde 200 com `{ items: [] }`, e `semPlaquinha` vira `undefined`.
   */
  it('soma as unidades em estoque sem plaquinha de todos os produtos', async () => {
    expect(await fila()).toBe(0);

    entrarComUnidades(loja, moto, 3, 'nf-1');
    entrarComUnidades(loja, celular, 2, 'nf-2');

    expect(await fila()).toBe(5);
  });

  /** Sem token não se lê nada — o corte por empresa vem justamente dele. */
  it('recusa sem token', async () => {
    const res = await request(app).get('/api/v1/core/units/summary');
    expect(res.status).toBe(401);
  });
});

describe('o que a fila NÃO conta', () => {
  /**
   * A unidade que já tem plaquinha saiu da fila — é o trabalho já feito.
   *
   * O vínculo é feito pelo caminho real, atravessando empresa: unidade na loja,
   * plaquinha na oficina. Derruba o `equipment_id IS NULL`.
   */
  it('não conta a unidade que já ganhou plaquinha', async () => {
    const [unitId] = entrarComUnidades(loja, moto, 2, 'nf-1');
    expect(await fila()).toBe(2);

    const plaquinha = criarPlaquinha();
    vincularUnidade({ companyId: loja, unitId, equipmentId: plaquinha.id, userId: vendedor });

    expect(await fila()).toBe(1);
  });

  /**
   * A peça VENDIDA sem plaquinha é passado.
   *
   * Ninguém volta atrás no vínculo depois que a moto saiu com o cliente.
   * Contá-la faria a fila crescer para sempre com trabalho que não existe mais —
   * e uma fila que só sobe é uma fila que ninguém tenta esvaziar. Derruba o
   * `status = 'in_stock'`.
   */
  it('não conta a unidade vendida', async () => {
    const ids = entrarComUnidades(loja, moto, 2, 'nf-1');
    expect(await fila()).toBe(2);

    createSale({
      companyId: loja,
      userId: vendedor,
      items: [{ productId: moto, quantity: 1, unitIds: [ids[0]] }],
      payments: [{ method: 'dinheiro', amountCents: 1_800_000 }],
      idempotencyKey: 'venda-fila-1',
    });

    expect(await fila()).toBe(1);
  });

  /** Perda, quebra e devolução ao fornecedor também tiram a peça da fila. */
  it('não conta a unidade baixada', async () => {
    const ids = entrarComUnidades(loja, moto, 2, 'nf-1');
    expect(await fila()).toBe(2);

    const baixa = await request(app)
      .post(`/api/v1/core/units/${ids[0]}/write-off`)
      .set(auth)
      .send({ reason: 'quebra no pátio' });
    expect(baixa.status).toBe(200);

    expect(await fila()).toBe(1);
  });
});

describe('isolamento entre empresas', () => {
  /**
   * O estoque da outra loja não entra nesta fila.
   *
   * O grupo tem mais de uma loja e a mesma pessoa pode operar as duas. Um número
   * inflado pelo pátio alheio mandaria o operador procurar um trabalho que não
   * está na tela dele — e o contrário, no token da outra loja, esconderia o
   * dele. Derruba o `company_id = ?`.
   */
  it('cada loja vê só as próprias unidades', async () => {
    const motoDaOutra = createProduct(outraLoja, { name: 'Biz 125', priceCents: 1_500_000 }).id;
    updateProduct(outraLoja, motoDaOutra, { serialized: true });

    entrarComUnidades(loja, moto, 2, 'nf-1');
    entrarComUnidades(outraLoja, motoDaOutra, 7, 'nf-2');

    expect(await fila()).toBe(2);

    const outraAuth = {
      Authorization: `Bearer ${await tokenDe('BALCAO_FILA_2', outraLoja)}`,
    };
    expect(await fila(outraAuth)).toBe(7);
  });
});
