/**
 * A VENDA DA OS TEM CAMINHO FISCAL — GAP-PRD-024 (metade da mercadoria).
 *
 * O checkout da OS criava a venda com UMA linha "Ordem de serviço #N", sem
 * produto: a NFC-e recusava a venda inteira por NCM/CFOP/origem ausentes, a
 * peça (ICMS) e a mão de obra (ISS) viravam um valor só, e nenhum insumo
 * externo resolvia isso.
 *
 * O que cada teste derruba:
 *   - volte o checkout para a linha única e a venda deixa de ter as peças;
 *   - esqueça a devolução e o cliente paga (e a nota declara) o que voltou;
 *   - deixe a mão de obra entrar na nota de mercadoria e a NFC-e declara
 *     serviço com NCM de peça;
 *   - esqueça o rateio e o vPag deixa de fechar com o vNF;
 *   - tire a itemização pela OS e a venda que JÁ EXISTE no banco (cobrada
 *     antes desta correção) fica sem nota para sempre.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { getConnection } from '../src/db/sqlite.js';
import { resetDbForTests } from '../src/db/database.js';
import { ensureOfficialWorkshops } from '../src/db/core-migrations.js';
import {
  linkUserToCompany,
  linkUserToWorkshop,
  upsertCompany,
  upsertUser,
} from '../src/services/auth/IdentityService.js';
import { updateFiscalConfig } from '../src/services/core/FiscalConfigService.js';
import { setSeriesNextNumber } from '../src/services/core/FiscalKeyService.js';
import { createNfceForSale } from '../src/services/core/FiscalDocumentService.js';
import { emissionReadinessForSale } from '../src/services/core/FiscalPipelineService.js';
import { loadSaleForNfce } from '../src/services/core/FiscalXmlNfce.js';
import { validarLeiauteNfe } from '../src/services/core/FiscalXsdValidator.js';
import { ratearPagamentos } from '../src/services/core/FiscalVendaDaOficina.js';
import { grupoTributarioPadrao } from './helpers/grupoTributario.js';

const app = createApp();
const SENHA = 'Teste@OsFiscal2026';

let oficina: string;
let mobilidade: string;
let gerente: { Authorization: string };
let peca: string;

async function entrar(login: string, perfil: string): Promise<{ Authorization: string }> {
  const userId = await upsertUser({ login, displayName: login, password: SENHA });
  linkUserToCompany(userId, oficina, perfil, true);
  linkUserToWorkshop(userId, mobilidade, 'mecanico');
  const res = await request(app).post('/api/v1/auth/login').send({ login, password: SENHA });
  expect(res.status).toBe(200);
  return { Authorization: `Bearer ${res.body.accessToken}` };
}

/** OS com peças e mão de obra, concluída e esperando o caixa. */
async function osConcluida(opcoes: {
  quantidade?: number;
  devolver?: number;
  maoDeObraCents?: number;
} = {}): Promise<{ orderId: string; totalCents: number }> {
  const os = await request(app)
    .post('/api/v1/core/workshop/orders')
    .set(gerente)
    .send({ customerName: 'Maria', complaint: 'Freio' });
  const orderId = os.body.id as string;
  await request(app)
    .post(`/api/v1/core/workshop/orders/${orderId}/assume`)
    .set(gerente)
    .send({ status: 'em_andamento', comment: 'assumindo' });
  if ((opcoes.quantidade ?? 2) > 0) {
    const lanc = await request(app)
      .post(`/api/v1/core/workshop/orders/${orderId}/parts`)
      .set(gerente)
      .send({ productId: peca, quantity: opcoes.quantidade ?? 2 });
    expect(lanc.status, JSON.stringify(lanc.body)).toBe(201);
  }
  if (opcoes.devolver) {
    const linha = getConnection()
      .prepare('SELECT id FROM core_service_order_parts WHERE order_id = ?')
      .get(orderId) as { id: string };
    const volta = await request(app)
      .post(`/api/v1/core/workshop/orders/${orderId}/parts/${linha.id}/return`)
      .set(gerente)
      .send({ quantity: opcoes.devolver, reason: 'sobrou' });
    expect(volta.status, JSON.stringify(volta.body)).toBe(200);
  }
  const mao = await request(app)
    .post(`/api/v1/core/workshop/orders/${orderId}/labor`)
    .set(gerente)
    .send({ laborCents: opcoes.maoDeObraCents ?? 5000 });
  expect(mao.status, JSON.stringify(mao.body)).toBe(200);
  const fim = await request(app)
    .post(`/api/v1/core/workshop/orders/${orderId}/complete`)
    .set(gerente)
    .send({ diagnosis: 'Trocadas as pastilhas', hasCost: true, forcarChecklist: true });
  expect(fim.status, JSON.stringify(fim.body)).toBe(200);
  return { orderId, totalCents: Number(fim.body.total_cents) };
}

async function cobrar(
  orderId: string,
  payments: { method: string; amountCents: number }[],
): Promise<string> {
  const res = await request(app)
    .post(`/api/v1/core/workshop/orders/${orderId}/checkout`)
    .set(gerente)
    .send({ payments });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body.sale.id as string;
}

function itensDaVenda(saleId: string) {
  return getConnection()
    .prepare(
      `SELECT product_id, description, quantity, unit_price_cents, total_cents, cost_cents
         FROM core_sale_items WHERE sale_id = ? ORDER BY rowid`,
    )
    .all(saleId) as unknown as {
    product_id: string | null;
    description: string;
    quantity: number;
    unit_price_cents: number;
    total_cents: number;
    cost_cents: number | null;
  }[];
}

beforeEach(async () => {
  resetDbForTests();
  oficina = upsertCompany({ slug: 'oficina', legalName: 'Oficina Ltda', tradeName: 'Oficina', kind: 'workshop' });
  upsertCompany({ slug: 'preco-justo', legalName: 'Preço Justo Ltda', tradeName: 'Preço Justo' });
  ensureOfficialWorkshops();
  mobilidade = (
    getConnection().prepare("SELECT id FROM core_workshops WHERE slug = 'oficina-mobilidade'").get() as {
      id: string;
    }
  ).id;
  gerente = await entrar('GER_OS_FISCAL', 'gerente_oficina');

  updateFiscalConfig({
    companyId: oficina,
    patch: {
      legalName: 'Oficina Sampaio Ltda',
      cnpj: '11.222.333/0001-81',
      ie: '123456789',
      crt: '1',
      street: 'Rua da Oficina',
      number: '50',
      district: 'Centro',
      cityName: 'Pelotas',
      cityIbge: '4314407',
      zip: '96010-000',
      uf: 'RS',
    },
  });
  grupoTributarioPadrao(oficina);
  setSeriesNextNumber({ companyId: oficina, model: '65', serie: 1, nextNumber: 1 });

  const p = await request(app)
    .post('/api/v1/core/products')
    .set(gerente)
    .send({ name: 'Pastilha de freio', priceCents: 9000, costCents: 4000, kind: 'part', workshopId: mobilidade });
  expect(p.status, JSON.stringify(p.body)).toBe(201);
  peca = p.body.id as string;
  getConnection()
    .prepare("UPDATE core_products SET ncm = '87083090', cfop = '5102', origin = '0' WHERE id = ?")
    .run(peca);
  await request(app).post('/api/v1/core/stock/movements').set(gerente).send({
    productId: peca,
    movementType: 'in',
    quantity: 5,
    referenceType: 'entrada',
    referenceId: 'nf-pecas',
  });
});

describe('o checkout da OS cria a venda itemizada', () => {
  it('peça com produto e custo; mão de obra como serviço; sem rebaixar estoque', async () => {
    const { orderId, totalCents } = await osConcluida();
    expect(totalCents).toBe(23_000);
    const venda = await cobrar(orderId, [{ method: 'pix', amountCents: 23_000 }]);

    expect(itensDaVenda(venda)).toEqual([
      {
        product_id: peca,
        description: 'Pastilha de freio',
        quantity: 2,
        unit_price_cents: 9000,
        total_cents: 18_000,
        cost_cents: 4000,
      },
      {
        product_id: null,
        description: 'Mão de obra — OS #1',
        quantity: 1,
        unit_price_cents: 5000,
        total_cents: 5000,
        cost_cents: null,
      },
    ]);
    const s = getConnection()
      .prepare('SELECT total_cents, subtotal_cents FROM core_sales WHERE id = ?')
      .get(venda) as { total_cents: number; subtotal_cents: number };
    expect(s).toEqual({ total_cents: 23_000, subtotal_cents: 23_000 });

    // A peça baixou UMA vez (na conclusão): 5 − 2.
    const saldo = getConnection()
      .prepare('SELECT quantity FROM core_stock WHERE product_id = ?')
      .get(peca) as { quantity: number };
    expect(saldo.quantity).toBe(3);
    const lancamentos = getConnection()
      .prepare("SELECT COUNT(*) AS n FROM core_finance_entries WHERE origin_type = 'sale' AND origin_id = ?")
      .get(venda) as { n: number };
    expect(lancamentos.n).toBe(1);
  });

  it('a peça devolvida não entra na venda', async () => {
    const { orderId, totalCents } = await osConcluida({ quantidade: 2, devolver: 1 });
    expect(totalCents).toBe(14_000);
    const venda = await cobrar(orderId, [{ method: 'pix', amountCents: 14_000 }]);
    const itens = itensDaVenda(venda);
    expect(itens[0]).toMatchObject({ product_id: peca, quantity: 1, total_cents: 9000 });
    expect(itens[1]).toMatchObject({ product_id: null, total_cents: 5000 });
  });

  it('OS cuja conta não fecha é recusada antes de criar a venda', async () => {
    const { orderId } = await osConcluida();
    getConnection().prepare('UPDATE core_service_orders SET total_cents = 99999 WHERE id = ?').run(orderId);
    const res = await request(app)
      .post(`/api/v1/core/workshop/orders/${orderId}/checkout`)
      .set(gerente)
      .send({ payments: [{ method: 'pix', amountCents: 99_999 }] });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('CORE_ORDER_TOTAL_MISMATCH');
    const n = getConnection().prepare('SELECT COUNT(*) AS n FROM core_sales').get() as { n: number };
    expect(n.n).toBe(0);
  });
});

describe('a nota da OS leva só a mercadoria', () => {
  it('NFC-e com as peças: vNF das peças, pagamento rateado, dentro do leiaute', async () => {
    const { orderId } = await osConcluida();
    const venda = await cobrar(orderId, [
      { method: 'pix', amountCents: 13_000 },
      { method: 'dinheiro', amountCents: 10_000 },
    ]);

    // O certificado A1 é cobrado na transmissão (e este teste não instala
    // um); o que importa aqui é que NENHUM motivo é da venda em si.
    const prontidao = emissionReadinessForSale(oficina, venda);
    expect(prontidao.reasons.filter((r) => /det\[|NCM|CFOP|origem|serviço|itens/.test(r))).toEqual([]);

    const { document } = createNfceForSale({ companyId: oficina, saleId: venda });
    const xml = (
      getConnection().prepare('SELECT xml_original FROM core_fiscal_documents WHERE id = ?').get(document.id) as {
        xml_original: string;
      }
    ).xml_original;
    const dets = [...xml.matchAll(/<det nItem=/g)];
    expect(dets).toHaveLength(1);
    expect(xml).toContain('<xProd>Pastilha de freio</xProd>');
    expect(xml).not.toContain('Mão de obra');
    expect(xml).toContain('<vNF>180.00</vNF>');
    const vPag = [...xml.matchAll(/<vPag>([\d.]+)<\/vPag>/g)].map((m) => Math.round(Number(m[1]) * 100));
    expect(vPag.reduce((s, v) => s + v, 0)).toBe(18_000);
    expect(vPag).toHaveLength(2);
    const xsd = validarLeiauteNfe(xml);
    expect(xsd.validated).toBe(true);
    expect(xsd.problems).toEqual([]);
  });

  it('OS só de mão de obra: a nota de mercadoria diz que o documento é a NFS-e', async () => {
    const { orderId } = await osConcluida({ quantidade: 0, maoDeObraCents: 7000 });
    const venda = await cobrar(orderId, [{ method: 'pix', amountCents: 7000 }]);
    const prontidao = emissionReadinessForSale(oficina, venda);
    expect(prontidao.canEmit).toBe(false);
    expect(prontidao.reasons.join(' ')).toMatch(/só de serviço.*NFS-e/);
    expect(() => createNfceForSale({ companyId: oficina, saleId: venda })).toThrow(/NFS-e/);
  });

  it('venda de OS cobrada antes da correção (linha única) ganha as peças pela OS', async () => {
    const { orderId } = await osConcluida();
    const venda = await cobrar(orderId, [{ method: 'pix', amountCents: 23_000 }]);
    // O banco que já existe: uma linha só, sem produto, com o total inteiro.
    const db = getConnection();
    db.prepare('DELETE FROM core_sale_items WHERE sale_id = ?').run(venda);
    db.prepare(
      `INSERT INTO core_sale_items (id, sale_id, company_id, product_id, description, quantity,
                                    unit_price_cents, discount_cents, total_cents)
       VALUES ('legado-1', ?, ?, NULL, 'Ordem de serviço #1', 1, 23000, 0, 23000)`,
    ).run(venda, oficina);

    const lida = loadSaleForNfce(oficina, venda);
    expect(lida.items.map((i) => [i.productId, i.quantity, i.totalCents])).toEqual([[peca, 2, 18_000]]);
    expect(lida.totalCents).toBe(18_000);
    expect(lida.servicos).toEqual([{ description: 'Mão de obra — OS #1', totalCents: 5000 }]);
    const motivos = emissionReadinessForSale(oficina, venda).reasons;
    expect(motivos.filter((r) => /det\[|NCM|CFOP|origem|serviço|itens/.test(r))).toEqual([]);
  });
});

describe('o rateio do pagamento', () => {
  it('fecha no centavo, na proporção, e tira o troco do dinheiro', () => {
    expect(
      ratearPagamentos(
        [
          { method: 'pix', amountCents: 13_000 },
          { method: 'dinheiro', amountCents: 12_000 },
        ],
        2_000,
        18_000,
      ),
    ).toEqual([
      { method: 'pix', amountCents: 10_173 },
      { method: 'dinheiro', amountCents: 7_827 },
    ]);
  });
});
